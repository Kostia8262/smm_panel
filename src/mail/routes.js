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
import { CONSENT_BASES, CONTACT_STATUS, IMPORT_LIMITS } from './specs.js';
import * as store from './store.js';
import * as pipeline from './import/pipeline.js';

const { MailError } = store;

/**
 * @param {import('express').Express} app
 * @param {{requireAccess: (area: string) => Function, currentProjectId: (req: object) => number|null, can: (role: string, area: string) => boolean}} deps
 */
export function mountMailRoutes(app, { requireAccess, currentProjectId, can }) {
  const router = express.Router();
  const view = requireAccess('mail');
  const manage = requireAccess('mail_contacts');

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

  app.use(router);
}
