/**
 * Маршруты рассылки. Отдельным модулем: server.js и так больше тысячи строк,
 * а у рассылки впереди ещё ящики, письма и очередь (docs/рассылка.md).
 *
 * Права — две области из `ACCESS` (src/staff.js):
 *   mail          — страница и названия баз со счётчиками: СММщик выбирает
 *                   базу для письма, не видя адресов;
 *   mail_contacts — содержимое баз, загрузка, правка, выгрузка.
 */

import express from 'express';
import multer from 'multer';
import { log } from '../db.js';
import { CONSENT_BASES, CONTACT_STATUS, IMPORT_LIMITS, SENDING } from './specs.js';
import * as store from './store.js';
import * as pipeline from './import/pipeline.js';
import * as senders from './sender/senders.js';
import * as googleOauth from './sender/google-oauth.js';
import * as unsubscribe from './unsubscribe.js';
import { renderLetter, sampleBlocks } from './compose/render.js';
import { brandFor } from './compose/brand.js';
import * as campaigns from './campaigns.js';
import * as mailMedia from './compose/media.js';
import * as runner from './runner.js';
import * as report from './report.js';
import * as bounces from './bounces.js';
import * as signups from './signups.js';
import { makeState, readState } from '../oauth/threads.js';
import { getProject } from '../projects.js';
import { tooManyAttempts } from '../ratelimit.js';
import { pingLeads } from '../links.js';

const { MailError } = store;

/**
 * @param {import('express').Express} app
 * @param {{requireAccess: (area: string) => Function, currentProjectId: (req: object) => number|null,
 *   can: (role: string, area: string) => boolean, publicBase: () => string}} deps
 */
export function mountMailRoutes(app, { requireAccess, currentProjectId, can, publicBase }) {
  const router = express.Router();
  const view = requireAccess('mail');
  const manage = requireAccess('mail_contacts');
  const mailboxes = requireAccess('mail_senders');

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: IMPORT_LIMITS.maxBytes, files: 1 },
    defParamCharset: 'utf8',
  }).single('file');

  /** Ошибка предметная — ответ с объяснением; остальное — в журнал и общее «не вышло». */
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof MailError) return res.status(err.status).json({ error: err.message });
      log('error', `рассылка: сбой на ${req.method} ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Что-то пошло не так — подробности в журнале' });
    }
  };

  const projectOf = (req) => {
    const id = currentProjectId(req);
    if (!id) throw new MailError('Не выбран проект', 400);
    return id;
  };

  const listOf = (req, id) => {
    const list = store.getList(id);
    if (!list || list.projectId !== projectOf(req)) throw new MailError('База не найдена', 404);
    return list;
  };

  const contactOf = (req, id) => {
    const row = store.getContactRow(id);
    if (!row || row.project_id !== projectOf(req)) throw new MailError('Контакт не найден', 404);
    return row;
  };

  /* --------------------------------- базы --------------------------------- */

  router.get(
    '/api/mail/summary',
    view,
    handle((req, res) => {
      const projectId = projectOf(req);
      const canManage = can(req.user.role, 'mail_contacts');
      res.json({
        summary: store.projectSummary(projectId),
        lists: store.listLists(projectId, { includeArchived: req.query.archived === '1' }),
        pendingImports: canManage ? pipeline.pendingImports(projectId) : [],
        consentBases: Object.fromEntries(Object.entries(CONSENT_BASES).map(([id, b]) => [id, b.title])),
        statuses: CONTACT_STATUS,
        canManage,
      });
    })
  );

  router.post(
    '/api/mail/lists',
    manage,
    handle((req, res) => {
      const list = store.createList(projectOf(req), req.body || {}, req.user.id);
      res.status(201).json({ list });
    })
  );

  router.put(
    '/api/mail/lists/:id',
    manage,
    handle((req, res) => {
      const list = listOf(req, req.params.id);
      res.json({ list: store.updateList(list.id, req.body || {}) });
    })
  );

  /* -------------------------------- контакты -------------------------------- */

  router.get(
    '/api/mail/contacts',
    manage,
    handle((req, res) => {
      const projectId = projectOf(req);
      const list = req.query.list && req.query.list !== 'all' ? listOf(req, req.query.list) : null;
      res.json({
        list,
        ...store.listContacts({
          projectId,
          listId: list?.id ?? null,
          q: req.query.q,
          status: req.query.status,
          page: req.query.page,
          sort: req.query.sort,
        }),
      });
    })
  );

  router.get(
    '/api/mail/export.csv',
    manage,
    handle((req, res) => {
      const projectId = projectOf(req);
      const list = req.query.list && req.query.list !== 'all' ? listOf(req, req.query.list) : null;
      const out = store.exportCsv({ projectId, listId: list?.id ?? null });
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `${out.name} ${stamp}.csv`.replace(/[\\/:*?"<>|]+/g, ' ');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      // Имя кириллицей — только через filename*: простой filename браузеры
      // читают как latin1, и файл сохранялся бы кракозябрами.
      res.setHeader('Content-Disposition', `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(out.csv);
    })
  );

  router.post(
    '/api/mail/contacts',
    manage,
    handle((req, res) => {
      const list = listOf(req, req.body?.listId);
      const result = store.addContactManually({
        listId: list.id,
        email: req.body?.email,
        name: req.body?.name,
        staffId: req.user.id,
      });
      res.status(201).json(result);
    })
  );

  router.post(
    '/api/mail/contacts/bulk',
    manage,
    handle((req, res) => {
      const body = req.body || {};
      res.json(
        store.bulk({
          projectId: projectOf(req),
          ids: body.ids,
          action: body.action,
          listId: body.listId,
          targetListId: body.targetListId,
          note: body.note,
        })
      );
    })
  );

  router.get(
    '/api/mail/contacts/:id',
    manage,
    handle((req, res) => {
      const row = contactOf(req, req.params.id);
      res.json({ contact: store.getContact(row.id) });
    })
  );

  router.put(
    '/api/mail/contacts/:id',
    manage,
    handle((req, res) => {
      const row = contactOf(req, req.params.id);
      const body = req.body || {};
      if (body.listId && body.attrs) {
        const list = listOf(req, body.listId);
        store.updateMemberAttrs(list.id, row.id, body.attrs);
      }
      res.json({ contact: store.updateContact(row.id, { name: body.name, email: body.email }) });
    })
  );

  router.post(
    '/api/mail/contacts/:id/resubscribe',
    manage,
    handle((req, res) => {
      const row = contactOf(req, req.params.id);
      res.json({ contact: store.resubscribe(row.id, req.body?.note) });
    })
  );

  router.post(
    '/api/mail/contacts/:id/erase',
    manage,
    handle((req, res) => {
      const row = contactOf(req, req.params.id);
      store.erase(row.id);
      res.json({ ok: true });
    })
  );

  /* -------------------------------- загрузки -------------------------------- */

  router.post(
    '/api/mail/imports',
    manage,
    (req, res, next) =>
      upload(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Файл больше 20 МБ — разделите его на части' });
        res.status(400).json({ error: `Файл не принят: ${err.message}` });
      }),
    handle((req, res) => {
      if (!req.file?.buffer?.length) throw new MailError('Выберите файл или вставьте адреса');
      const pasted = req.body?.pasted === '1';
      const { id } = pipeline.createImport({
        projectId: projectOf(req),
        staffId: req.user.id,
        bytes: new Uint8Array(req.file.buffer),
        sourceName: pasted ? 'вставленный текст' : req.file.originalname,
        listId: req.body?.listId ? Number(req.body.listId) : null,
      });
      res.status(201).json({ id });
    })
  );

  router.get(
    '/api/mail/imports/:id',
    manage,
    handle((req, res) => {
      const projectId = projectOf(req);
      const data = pipeline.readImport(req.params.id, {
        projectId,
        verdict: req.query.verdict,
        page: req.query.page,
      });
      const listId = req.query.listId && req.query.listId !== 'new' ? listOf(req, req.query.listId).id : null;
      data.forecast = pipeline.forecast(req.params.id, {
        projectId,
        listId,
        includeWarnings: req.query.warnings !== '0',
      });
      res.json(data);
    })
  );

  router.put(
    '/api/mail/imports/:id',
    manage,
    handle((req, res) => {
      const body = req.body || {};
      pipeline.reparseImport(req.params.id, {
        projectId: projectOf(req),
        encoding: body.encoding,
        delimiter: body.delimiter,
        sheet: body.sheet,
        hasHeader: body.hasHeader,
        roles: body.roles,
      });
      res.json({ ok: true });
    })
  );

  router.put(
    '/api/mail/imports/:id/decisions',
    manage,
    handle((req, res) => {
      pipeline.setDecisions(req.params.id, {
        projectId: projectOf(req),
        rows: req.body?.rows || [],
        all: req.body?.all ?? null,
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/api/mail/imports/:id/commit',
    manage,
    handle((req, res) => {
      const body = req.body || {};
      const projectId = projectOf(req);
      if (body.listId) listOf(req, body.listId);
      const result = pipeline.commitImport(req.params.id, {
        projectId,
        staffId: req.user.id,
        listId: body.listId ? Number(body.listId) : null,
        newList: body.newList || null,
        includeWarnings: body.includeWarnings !== false,
      });
      res.json(result);
    })
  );

  router.delete(
    '/api/mail/imports/:id',
    manage,
    handle((req, res) => {
      pipeline.discardImport(req.params.id, { projectId: projectOf(req) });
      res.json({ ok: true });
    })
  );

  /* ------------------------ ящики-отправители (фаза 2) ------------------------ */

  /** Адрес возврата. До символа совпадает с вписанным в Google Cloud → Clients. */
  const googleRedirectUri = () => `${publicBase()}/oauth/google`;

  router.get(
    '/api/mail/senders',
    mailboxes,
    handle((_req, res) => {
      const googleApp = senders.googleApp();
      res.json({
        app: { clientId: googleApp.clientId, hasSecret: Boolean(googleApp.clientSecret), redirectUri: googleRedirectUri() },
        senders: senders.listSenders({ includeDisconnected: true }),
        limits: { window: SENDING.window, warmup: SENDING.warmup, testRecipientsMax: SENDING.testRecipientsMax },
      });
    })
  );

  router.get(
    '/api/mail/senders/alerts',
    view,
    handle((_req, res) => res.json(senders.senderAlerts()))
  );

  router.put(
    '/api/mail/google-app',
    mailboxes,
    handle((req, res) => {
      senders.saveGoogleApp(req.body || {});
      const googleApp = senders.googleApp();
      res.json({ app: { clientId: googleApp.clientId, hasSecret: Boolean(googleApp.clientSecret), redirectUri: googleRedirectUri() } });
    })
  );

  /**
   * Ссылка на окно согласия Google. Отдаётся ссылкой, а не редиректом: экран
   * сперва объясняет по-человечески, если приложение не заполнено.
   */
  router.post(
    '/api/mail/senders/oauth/start',
    mailboxes,
    handle((req, res) => {
      const googleApp = senders.googleApp();
      if (!googleApp.configured) throw new MailError('Сначала впишите Client ID и Client secret приложения Google');
      const state = makeState({ projectId: projectOf(req), staffId: req.user.id, platform: 'google' });
      res.json({
        url: googleOauth.authorizeUrl({
          clientId: googleApp.clientId,
          redirectUri: googleRedirectUri(),
          state,
          loginHint: String(req.body?.loginHint || ''),
        }),
      });
    })
  );

  /** Возврат из окна Google. Страница, а не API: сюда приходит браузер человека. */
  router.get('/oauth/google', async (req, res) => {
    const back = (params) => res.redirect(`/?${new URLSearchParams({ oauth: 'google', ...params })}#/mail/senders`);
    if (!req.user || !can(req.user.role, 'mail_senders')) return back({ result: 'error', message: 'подключать ящики может только владелец' });
    if (req.query.error) {
      const reason = req.query.error === 'access_denied' ? 'в окне Google нажали «Отмена»' : String(req.query.error_description || req.query.error);
      return back({ result: 'error', message: reason });
    }
    try {
      readState(String(req.query.state || ''), { staffId: req.user.id, platform: 'google' });
      const googleApp = senders.googleApp();
      const out = await googleOauth.exchangeCode({
        clientId: googleApp.clientId,
        clientSecret: googleApp.clientSecret,
        redirectUri: googleRedirectUri(),
        code: req.query.code,
      });
      const sender = senders.saveConnected({
        email: out.email,
        refreshToken: out.refreshToken,
        scopes: out.scopes,
        refreshExpiresAt: out.refreshExpiresAt,
        staffId: req.user.id,
      });
      return back({ result: 'ok', email: sender.email, temporary: out.refreshExpiresAt ? '1' : '' });
    } catch (err) {
      log('warn', `рассылка: подключение ящика не удалось: ${err.message}`);
      return back({ result: 'error', message: err.message });
    }
  });

  router.put(
    '/api/mail/senders/:id',
    mailboxes,
    handle((req, res) => res.json({ sender: senders.updateSender(req.params.id, req.body || {}) }))
  );

  router.post(
    '/api/mail/senders/:id/check',
    mailboxes,
    handle(async (req, res) => {
      try {
        res.json({ sender: await senders.checkSender(req.params.id) });
      } catch (err) {
        if (err instanceof MailError) throw err;
        res.status(502).json({ error: err.message, sender: senders.getSender(req.params.id) });
      }
    })
  );

  router.post(
    '/api/mail/senders/:id/test',
    mailboxes,
    handle(async (req, res) => {
      try {
        const result = await senders.sendTest(req.params.id, {
          to: Array.isArray(req.body?.to) ? req.body.to : [],
          projectId: projectOf(req),
          staffId: req.user.id,
          publicBase: publicBase(),
        });
        res.json({ ...result, sender: senders.getSender(req.params.id) });
      } catch (err) {
        if (err instanceof MailError) throw err;
        res.status(502).json({ error: err.message, sender: senders.getSender(req.params.id) });
      }
    })
  );

  router.delete(
    '/api/mail/senders/:id',
    mailboxes,
    handle(async (req, res) => {
      await senders.disconnect(req.params.id);
      res.json({ ok: true });
    })
  );

  /* ------------------------------ образец письма ------------------------------ */

  /**
   * Образец фирменной вёрстки школы — открывается в отдельной вкладке.
   *
   * Своя политика безопасности: вёрстка письма живёт на встроенных стилях, а
   * общая CSP панели их запрещает. Скрипты по-прежнему запрещены, картинки —
   * только по https (логотип лежит на сайте школы).
   */
  router.get(
    '/api/mail/sample.html',
    view,
    handle((req, res) => {
      const project = getProject(projectOf(req));
      if (!project) throw new MailError('Проект не найден', 404);
      const brand = brandFor(project);
      const { html } = renderLetter({
        brand,
        subject: `Образець листа — ${project.title}`,
        preheader: 'Так виглядатиме розсилка: місця під картинки підписані розмірами.',
        blocks: sampleBlocks(project, brand),
        signature: project.signature,
        reason: 'ви підписалися на новини школи',
        unsubscribeUrl: unsubscribe.unsubscribeUrl(publicBase(), unsubscribe.tokenFor({ projectId: project.id })),
      });
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      );
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    })
  );

  /* --------------------------------- письма (фаза 3) --------------------------------- */

  const campaignOf = (req) => campaigns.getCampaign(req.params.id, projectOf(req));

  /** Письмо целиком для редактора: сам текст, проверки, аудитория и то, из чего выбирать. */
  const editorPayload = (campaign) => ({
    campaign,
    check: campaigns.checkCampaign(campaign),
    delivery: runner.deliveryInfo(campaign),
    options: {
      lists: store.listLists(campaign.projectId).map((l) => ({ id: l.id, name: l.name, active: l.counts.active })),
      senders: senders.listSenders().map((s) => ({ id: s.id, email: s.email, state: s.state, cap: s.cap.effective, sent24h: s.sent24h })),
      statuses: campaigns.CAMPAIGN_STATUS,
    },
  });

  router.get(
    '/api/mail/campaigns',
    view,
    handle((req, res) => {
      // Прогноз окончания — только идущим и запланированным: остальным он ни о чём.
      const list = campaigns.listCampaigns(projectOf(req)).map((c) =>
        ['scheduled', 'sending', 'paused'].includes(c.status) ? { ...c, delivery: runner.deliveryInfo(campaigns.getCampaign(c.id)) } : c
      );
      res.json({ campaigns: list, statuses: campaigns.CAMPAIGN_STATUS });
    })
  );

  router.post(
    '/api/mail/campaigns',
    view,
    handle((req, res) => {
      const projectId = projectOf(req);
      const fromId = Number(req.body?.fromId) || null;
      if (fromId) campaigns.getCampaign(fromId, projectId);
      const campaign = fromId ? campaigns.copyCampaign(fromId, { staffId: req.user.id }) : campaigns.createCampaign(projectId, { staffId: req.user.id });
      res.status(201).json(editorPayload(campaign));
    })
  );

  router.get(
    '/api/mail/campaigns/:id',
    view,
    handle((req, res) => res.json(editorPayload(campaignOf(req))))
  );

  router.put(
    '/api/mail/campaigns/:id',
    view,
    handle((req, res) => {
      const current = campaignOf(req);
      res.json(editorPayload(campaigns.updateCampaign(current.id, req.body || {})));
    })
  );

  router.delete(
    '/api/mail/campaigns/:id',
    view,
    handle((req, res) => {
      campaigns.removeCampaign(campaignOf(req).id);
      res.json({ ok: true });
    })
  );

  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: mailMedia.MAIL_IMAGE_LIMITS.maxBytes, files: 1 },
    defParamCharset: 'utf8',
  }).single('file');

  router.post(
    '/api/mail/campaigns/:id/media',
    view,
    (req, res, next) =>
      imageUpload(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Картинка больше 2 МБ — для письма это слишком тяжело' });
        res.status(400).json({ error: `Файл не принят: ${err.message}` });
      }),
    handle((req, res) => {
      const campaign = campaignOf(req);
      if (!campaign.editable) throw new MailError('Письмо уже отправляется — картинки не меняются', 409);
      if (!req.file?.buffer?.length) throw new MailError('Выберите картинку');
      const row = mailMedia.saveImage(campaign.id, { buffer: req.file.buffer, originalName: req.file.originalname });
      res.status(201).json({ media: { id: row.id, name: row.stored_name, width: row.width, height: row.height, bytes: row.bytes, originalName: row.original_name } });
    })
  );

  /** Картинка письма для редактора — только вошедшим; получателю она уходит внутри письма. */
  router.get(
    '/api/mail/media/:name',
    view,
    handle((req, res) => {
      const found = mailMedia.mediaPath(req.params.name);
      if (!found) return res.status(404).type('text/plain').send('Картинки нет');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.type(found.row.mime).sendFile(found.path);
    })
  );

  /**
   * Предпросмотр письма в рамке редактора. Своя политика безопасности:
   * встроенные стили письма и картинки data:, без скриптов; рамка — только
   * из самой панели (`frame-ancestors 'self'` и SAMEORIGIN вместо общего DENY).
   * Документ `srcdoc` унаследовал бы CSP панели и остался бы без стилей.
   */
  router.get(
    '/api/mail/campaigns/:id/preview.html',
    view,
    handle((req, res) => {
      const campaign = campaignOf(req);
      const { html } = campaigns.buildLetter(campaign, {
        mode: 'preview',
        vars: { name: String(req.query.name || '') },
        unsubscribeUrl: unsubscribe.unsubscribeUrl(publicBase(), unsubscribe.tokenFor({ projectId: campaign.projectId })),
      });
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
      );
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    })
  );

  router.post(
    '/api/mail/campaigns/:id/test',
    view,
    handle(async (req, res) => {
      const campaign = campaignOf(req);
      try {
        const result = await campaigns.sendCampaignTest(campaign.id, {
          to: Array.isArray(req.body?.to) ? req.body.to : [],
          staffId: req.user.id,
          publicBase: publicBase(),
          projectId: campaign.projectId,
        });
        res.json({ ...result, ...editorPayload(campaigns.getCampaign(campaign.id)) });
      } catch (err) {
        if (err instanceof MailError) throw err;
        res.status(502).json({ error: err.message });
      }
    })
  );

  router.post(
    '/api/mail/campaigns/:id/submit',
    view,
    handle((req, res) => res.json(editorPayload(campaigns.submitCampaign(campaignOf(req).id, req.user))))
  );

  router.post(
    '/api/mail/campaigns/:id/approve',
    mailboxes,
    handle((req, res) => res.json(editorPayload(campaigns.approveCampaign(campaignOf(req).id, req.user))))
  );

  router.post(
    '/api/mail/campaigns/:id/reject',
    mailboxes,
    handle((req, res) => res.json(editorPayload(campaigns.rejectCampaign(campaignOf(req).id, req.user, req.body?.note))))
  );

  /* ------------------------------ отправка (фаза 4) ------------------------------ */

  /** { at: ISO | null } — null или время в прошлом = «разослать сейчас», только владельцу. */
  router.post(
    '/api/mail/campaigns/:id/schedule',
    view,
    handle((req, res) =>
      res.json(editorPayload(runner.scheduleCampaign(campaignOf(req).id, { at: req.body?.at || null, user: req.user, projectId: projectOf(req) })))
    )
  );

  router.post(
    '/api/mail/campaigns/:id/unschedule',
    view,
    handle((req, res) => res.json(editorPayload(runner.unscheduleCampaign(campaignOf(req).id, { user: req.user, projectId: projectOf(req) }))))
  );

  router.post(
    '/api/mail/campaigns/:id/pause',
    view,
    handle((req, res) => res.json(editorPayload(runner.pauseCampaign(campaignOf(req).id, { user: req.user, projectId: projectOf(req) }))))
  );

  router.post(
    '/api/mail/campaigns/:id/resume',
    view,
    handle((req, res) => res.json(editorPayload(runner.resumeCampaign(campaignOf(req).id, { user: req.user, projectId: projectOf(req) }))))
  );

  router.post(
    '/api/mail/campaigns/:id/cancel',
    mailboxes,
    handle((req, res) => res.json(editorPayload(runner.cancelCampaign(campaignOf(req).id, { user: req.user, projectId: projectOf(req) }))))
  );

  /** Письма рассылки поимённо — только владельцу: это адреса. */
  router.get(
    '/api/mail/campaigns/:id/sends',
    manage,
    handle((req, res) => {
      const campaign = campaignOf(req);
      const status = String(req.query.status || '');
      const page = Math.max(1, Number(req.query.page) || 1);
      res.json(campaigns.listSends(campaign.id, { status, page }));
    })
  );

  /* ------------------------------ результаты (фаза 5) ------------------------------ */

  /** Отчёт: переходы, отписки, заявки. Имена из заявок — только владельцу. */
  router.get(
    '/api/mail/campaigns/:id/report',
    view,
    handle(async (req, res) => {
      const campaign = campaignOf(req);
      res.json(await report.campaignReport(campaign, { withPeople: can(req.user.role, 'mail_contacts') }));
    })
  );

  /** Повтор писем с неизвестной судьбой — владелец, осознанно: часть людей получит письмо дважды. */
  router.post(
    '/api/mail/campaigns/:id/retry-unknown',
    mailboxes,
    handle((req, res) => res.json(editorPayload(report.retryUnknown(campaignOf(req).id, { user: req.user, projectId: projectOf(req) }))))
  );

  /* ------------------------------ фаза 6: возвраты и частота ------------------------------ */

  router.post(
    '/api/mail/bounces/preview',
    manage,
    handle((req, res) => res.json(bounces.previewBounces(projectOf(req), req.body?.text)))
  );

  router.post(
    '/api/mail/bounces/apply',
    manage,
    handle((req, res) => res.json(bounces.applyBounces(projectOf(req), req.body?.ids)))
  );

  router.get(
    '/api/mail/settings',
    view,
    handle((req, res) => res.json({ gapDays: campaigns.frequencyGapDays(projectOf(req)) }))
  );

  router.put(
    '/api/mail/settings',
    mailboxes,
    handle((req, res) => res.json({ gapDays: campaigns.setFrequencyGapDays(projectOf(req), req.body?.gapDays, req.user) }))
  );

  /* ------------------------------ отписка: наружу ------------------------------ */

  const unsubscribeHandler = (req, res) => {
    // Считаем все обращения, но с запасом: одна семья открывает ссылки из
    // нескольких писем, а перебирать токены смысла нет — они подписаны.
    if (tooManyAttempts(`unsubscribe:${req.ip}`, { limit: 60 })) {
      return res.status(429).type('text/plain').send('Забагато спроб. Спробуйте за кілька хвилин.');
    }
    let out;
    try {
      out = unsubscribe.handle({
        token: req.params.token,
        method: req.method,
        body: req.body || {},
        projectTitle: (id) => getProject(id)?.title || '',
      });
    } catch (err) {
      log('error', `рассылка: сбой страницы отписки: ${err.message}`);
      return res.status(500).type('text/plain').send('Щось пішло не так. Напишіть нам — відпишемо вручну.');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (out.text) return res.status(out.status).type('text/plain').send(out.text);
    res.status(out.status).type('html').send(out.html);
  };
  router.get('/u/:token', unsubscribeHandler);
  router.post('/u/:token', express.urlencoded({ extended: false, limit: '10kb' }), unsubscribeHandler);

  /* ------------------------------ подписка с сайтов: наружу ------------------------------ */

  /**
   * Форма в подвале сайта шлёт сюда адрес. Ответ — JSON для fetch; сайтам
   * своих доменов разрешено его прочитать (CORS). Форма без скриптов получает
   * страницу с тем же текстом.
   */
  // Встроенные браузеры Instagram и ChatGPT присылают `Origin: null` — тогда
  // сайт узнаём по Referer, а разрешение даём на тот же `null`.
  const formOrigin = (req) => {
    const origin = req.get('origin');
    return origin && origin !== 'null' ? origin : req.get('referer');
  };
  const corsFor = (req, res) => {
    const origin = req.get('origin');
    if (origin && signups.siteOf(formOrigin(req))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
  };
  router.options('/s/subscribe', (req, res) => {
    corsFor(req, res);
    res.status(204).end();
  });
  router.post('/s/subscribe', express.urlencoded({ extended: false, limit: '4kb' }), express.json({ limit: '4kb' }), async (req, res) => {
    corsFor(req, res);
    res.setHeader('Cache-Control', 'no-store');
    let out;
    try {
      out = await signups.subscribe({
        email: req.body?.email,
        school: req.body?.school,
        page: req.body?.page,
        honeypot: req.body?.website,
        consentVersion: req.body?.consent_version,
        lang: req.body?.lang,
        utm: { source: req.body?.utm_source, medium: req.body?.utm_medium, campaign: req.body?.utm_campaign },
        referrer: req.body?.referrer,
        landingPath: req.body?.landing_path,
        ...signups.requestSource({ ip: req.ip, origin: formOrigin(req), headers: req.headers }),
        publicBase: publicBase(),
      });
    } catch (err) {
      log('error', `рассылка: сбой приёма подписки: ${err.message}`);
      out = { status: 500, ok: false, code: 'error', message: 'Щось пішло не так. Спробуйте пізніше.' };
    }
    const wantsJson = (req.get('accept') || '').includes('application/json') || req.is('application/json');
    if (wantsJson) return res.status(out.status).json(out);
    res.status(out.status).type('html').send(unsubscribe.publicPage({ title: out.ok ? 'Перевірте пошту' : 'Не вдалося підписатися', text: out.message }));
  });

  const confirmHandler = (req, res) => {
    if (tooManyAttempts(`signup-confirm:${req.ip}`, { limit: 60 })) {
      return res.status(429).type('text/plain').send('Забагато спроб. Спробуйте за кілька хвилин.');
    }
    const out = signups.confirmPage({ token: req.params.token, method: req.method });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.status(out.status).type('html').send(out.html);
  };
  router.get('/s/confirm/:token', confirmHandler);
  router.post('/s/confirm/:token', express.urlencoded({ extended: false, limit: '4kb' }), confirmHandler);

  /**
   * «Проверить связь» с заявками школы. Маршрут общий для постов и писем, а
   * живёт здесь, потому что ключ интеграции появился вместе с отчётом рассылки.
   */
  router.post(
    '/api/settings/leads/check',
    requireAccess('platforms'),
    handle(async (_req, res) => {
      try {
        res.json({ ok: true, ...(await pingLeads()) });
      } catch (err) {
        res.status(422).json({ error: err.message });
      }
    })
  );

  router.get(
    '/api/mail/signups/stats',
    view,
    handle((req, res) => res.json(signups.signupStats(projectOf(req))))
  );

  app.use(router);
}
