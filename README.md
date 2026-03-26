# Cenz Control

Готовый проект браузерного расширения по мотивам описания из файла `9_Слынчук_ИИ_Проект.docx`.

Проект реализует:

- двухуровневую защиту: блокировку сайтов по внешнему списку и фильтрацию текста на разрешенных страницах;
- `popup` со статусом текущей вкладки и быстрыми переключателями;
- страницу `options` с настройками строгости, режима замены, доверенных сайтов, пользовательских исключений и источника данных;
- локальный `default-bundle.json` как кэш и аварийный fallback;
- автоматическую загрузку основного bundle-файла из GitHub Raw через `source-config.json`;
- скрипт сборки bundle и отдельный парсер выгрузки РКН.

## Структура

- `extension/manifest.json` — манифест расширения.
- `extension/service-worker.js` — фоновая логика: загрузка bundle, автообновление, блокировка URL.
- `extension/content-script.js` — фильтрация текстовых узлов и наблюдение за динамическим контентом.
- `extension/data/source-config.json` — конфиг GitHub Raw источника.
- `extension/data/default-bundle.json` — локальный fallback-кэш.
- `extension/scripts/updater/configure_github_source.py` — генератор `source-config.json`.
- `extension/scripts/updater/fetch_rkn_registry.py` — парсер выгрузки РКН.
- `extension/scripts/updater/build_bundle.py` — сборка итогового bundle JSON.

## Как подключить GitHub как основной источник

1. Опубликуйте репозиторий на GitHub.
2. Сформируйте `source-config.json`:

```powershell
py extension\scripts\updater\configure_github_source.py `
  --owner YOUR_GITHUB_LOGIN `
  --repo YOUR_REPO `
  --branch main `
  --bundle-path extension/data/default-bundle.json
```

3. Загрузите в браузер папку `extension` как unpacked extension.
4. Если поле `URL готового bundle-файла из GitHub Raw` в настройках оставить пустым, расширение будет использовать URL из `extension/data/source-config.json`.
5. Если нужно временно переопределить источник, можно вручную указать другой Raw URL прямо в настройках расширения.

## Как собрать bundle

Базовая сборка:

```powershell
py extension\scripts\updater\build_bundle.py
```

Сборка с выгрузкой РКН:

```powershell
py extension\scripts\updater\build_bundle.py `
  --rkn-source extension\scripts\updater\data\rkn-export.sample.xml
```

## Парсер РКН

Скрипт `fetch_rkn_registry.py` умеет:

- читать выгрузку РКН из локального файла;
- читать выгрузку РКН по URL;
- разбирать `XML`, `CSV`, `JSON`, `TXT`, а также `ZIP` и `GZ`;
- извлекать домены, IP и URL и превращать их в `blockedSites` для bundle-файла.

Пример:

```powershell
py extension\scripts\updater\fetch_rkn_registry.py `
  --source extension\scripts\updater\data\rkn-export.sample.xml `
  --output extension\scripts\updater\data\blocked-sites-rkn.json
```

Если официальный URL выгрузки требует авторизацию, можно передать JSON с заголовками:

```powershell
py extension\scripts\updater\fetch_rkn_registry.py `
  --source https://example.rkn.gov.ru/export.xml `
  --headers path\to\headers.json `
  --output extension\scripts\updater\data\blocked-sites-rkn.json
```

## Важное ограничение

Полная официальная выгрузка перечня ограничиваемых адресов у РКН предоставляется не анонимно: доступ к ней на сайте для операторов связи описан как доступ в ручном и автоматическом режимах с использованием квалифицированной электронной подписи. Поэтому в проекте реализован честный сценарий:

- расширение получает уже готовый bundle из GitHub Raw;
- парсер умеет разобрать официальную выгрузку РКН после того, как она получена из доступного вам канала.

## Что уже готово

- расширение работает без `npm` и без сборщика;
- GitHub Raw поддерживается как основной источник данных;
- локальный bundle остается fallback-кэшем;
- парсер РКН встроен в пайплайн сборки данных;
- проект можно загружать в браузер и демонстрировать сразу.
