/**
 * Версия Graph API Meta — одна на всю панель.
 *
 * До 13.09.2026 номер `v21.0` был вписан в восьми местах, и переезд значил
 * искать их поиском. Версии Meta живут около двух лет: v21.0 отключается
 * 21.01.2027, v26.0 вышла 29.07.2026. Следующий переезд — правка этой строки,
 * а перед ней сверка `tools/graph-version-probe.mjs --from <старая> --to <новая>`.
 *
 * Threads сюда не входит: у него свой хост и своя версия (`v1.0`, другой нет).
 *
 * Номер не берётся из `.env` намеренно: сервер и воркер читают `.env` уже после
 * того, как модули импортированы, и настройка молча не сработала бы.
 */

export const GRAPH_VERSION = 'v26.0';

/** Запросы к страницам, Instagram, токенам. */
export const GRAPH_API = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Загрузка видео по частям: Reels и сторис Facebook. */
export const RUPLOAD_API = `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}`;

/** Окно входа Facebook. */
export const LOGIN_DIALOG = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
