# Подключение TikTok

Порядок для владельца. Сверено с документацией TikTok for Developers 14.09.2026.
Код панели готов: кнопка «Подключить через TikTok», публикация сразу или в
черновики, форма поста по правилам аудита.

## 1. Приложение в TikTok for Developers (≈ 20 минут)

1. Войти на https://developers.tiktok.com под аккаунтом, от которого будет
   вестись приложение (лучше рабочая почта академии) → **Manage apps → Connect an app**.
2. **Basic information**
   - App name: `MyComputer SMM` — должно совпадать с названием на сайте.
   - App icon: 1024×1024, фавикон панели или логотип академии.
   - Description: «Content planner for social media teams: schedule posts, get them
     approved and publish videos to TikTok directly or as drafts.»
     Не писать «internal» и «личный инструмент» — TikTok отклоняет такие заявки.
   - Category: Business / Productivity.
   - Terms of Service URL: `https://smm.mycomputer.education/terms`
   - Privacy Policy URL: `https://smm.mycomputer.education/privacy`
   - Web/Desktop URL (сайт): `https://smm.mycomputer.education/about`
   - Platforms: **Web**.
3. **Add products**
   - **Login Kit** → Redirect URI: `https://smm.mycomputer.education/oauth/tiktok`
     (ровно так, без слеша на конце).
   - **Content Posting API** → включить **Direct Post**.
4. **Scopes**: `user.info.basic`, `video.publish`, `video.upload`.
5. **URL properties** (нужно для фото-постов и загрузки по ссылке, можно позже):
   добавить URL prefix `https://smm.mycomputer.education/media/` и пройти проверку.
   Способ проверки TikTok покажет в виджете — пришлите его, панель положит файл
   подтверждения.

## 2. Песочница — проверить до аудита

1. В приложении создать **Sandbox**, в нём — **Target users**: добавить TikTok-аккаунт академии
   **@mycomputer.academy**.
   У песочницы свои настройки: в ней тоже добавить Login Kit (тот же Redirect URI),
   Content Posting API с Direct Post и те же три scope.
2. Из песочницы взять **Client key** и **Client secret**.
3. В панели: Интеграции → Комп'ютерна академія → карточка TikTok → вписать ключ и секрет →
   «Сохранить» → **«Подключить через TikTok»** → войти под @mycomputer.academy.
4. Проверить: «Проверить связь», затем пост с роликом, видимость «Только я»
   (до аудита TikTok иначе не даст), и пост в режиме «В черновики TikTok».

## 3. Аудит

TikTok запрещает приложения «для личного использования» — в заявке панель
описывается как продукт (планировщик публикаций для команды), а не личный инструмент.

Нужно:
- открытые страницы `/about`, `/privacy`, `/terms` (ссылки видны без меню);
- **демо-видео** полного сценария (до 5 файлов по 50 МБ): вход в панель → карточка
  TikTok → «Подключить через TikTok» → окно согласия TikTok → пост с роликом →
  форма TikTok (аккаунт, «Кто увидит пост» без значения по умолчанию, галочки,
  отметка рекламы, фраза согласия) → «Опубликовать сейчас» → пост в TikTok;
  отдельно — режим черновика и уведомление во «Входящих» TikTok;
- после одобрения: в карточке TikTok поставить «Аудит TikTok пройден» = `true`,
  подключить **боевые** Client key/secret (не песочницы) и нажать «Переподключить».

Срок рассмотрения TikTok не называет; ориентир из опыта других сервисов — 1–4 недели.

## Что важно помнить

- Токен доступа живёт сутки, панель обновляет его сама; refresh token — год.
- Звук к ролику через API TikTok не выбрать: нужен трендовый звук — режим черновика.
- Черновиков, не опубликованных в приложении, — не больше пяти за сутки.
