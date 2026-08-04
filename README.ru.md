<table width="100%">
<tr>
<td valign="top">

# DocuMind

*Self-hosted RAG (Retrieval-Augmented Generation) ассистент для работы с документацией*

</td>
<td align="right" valign="top">

**Lang:**<br>
<a href="README.md"><img alt="ENG" src="https://img.shields.io/badge/ENG-0366d6?style=for-the-badge"></a>
<img alt="RUS" src="https://img.shields.io/badge/RUS-2ea44f?style=for-the-badge">

</td>
</tr>
</table>

<p align="center">
  <img alt="Python" src="https://img.shields.io/badge/Python_3.12-3776AB?style=for-the-badge&logo=python&logoColor=white">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL_16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white">
  <img alt="Redis" src="https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white">
  <img alt="Celery" src="https://img.shields.io/badge/Celery-37814A?style=for-the-badge&logo=celery&logoColor=white">
  <br>
  <img alt="React" src="https://img.shields.io/badge/React_19-61DAFB?style=for-the-badge&logo=react&logoColor=black">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white">
  <img alt="OpenAI" src="https://img.shields.io/badge/OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white">
</p>

Загружайте PDF/DOCX документы, они автоматически парсятся и разбиваются на
чанки, которые можно просмотреть и отредактировать, после чего можно
общаться с LLM, которая отвечает, опираясь на найденный контекст из ваших
документов. Встроенный дашборд показывает журнал событий пайплайна,
статистику использования и 3D-визуализацию эмбеддингов чанков.

<p align="center">
  <a href="#-превью">Превью</a> ·
  <a href="#-стек-технологий">Стек технологий</a> ·
  <a href="#-архитектура">Архитектура</a> ·
  <a href="#-api-эндпоинты">API-эндпоинты</a> ·
  <a href="#-структура-проекта">Структура проекта</a> ·
  <a href="#-быстрый-старт">Быстрый старт</a>
</p>

---

<a id="-превью"></a>

## 🖼️ Превью

| Загрузка | Просмотр чанков |
|---|---|
| ![Страница загрузки](docs/images/upload.png) | ![Просмотр чанков](docs/images/chunks.png) |

| Чат | Дашборд |
|---|---|
| ![Страница чата](docs/images/chat.png) | ![Дашборд](docs/images/dashboard.png) |

---

<a id="-стек-технологий"></a>

## 🛠️ Стек технологий

**Backend**
- Python 3.12, FastAPI + Uvicorn
- SQLAlchemy — асинхронный (asyncpg) для API, синхронный (psycopg) для Alembic и Celery-воркера
- PostgreSQL 16 + pgvector — единое хранилище для документов, чанков, эмбеддингов, истории чата и журнала событий
- Celery + Redis (только брокер, без result backend — результаты задач пишутся напрямую в Postgres)
- OpenAI API — эмбеддинги и chat completions (модели настраиваются, см. `.env.example`)
- pypdf / python-docx для извлечения текста, numpy + umap-learn для проекции эмбеддингов в 3D
- Alembic для миграций схемы БД
- pytest + pytest-cov для тестирования

**Frontend**
- React 19 + TypeScript, сборка на Vite
- Mantine UI (core / dates / dropzone / hooks) — библиотека компонентов
- react-router-dom для роутинга
- 3d-force-graph + three.js для 3D-графа эмбеддингов чанков
- Vitest + Testing Library для тестов, oxlint для линтинга

**Инфраструктура**
- Docker Compose для локального развёртывания (postgres, redis, backend, worker, frontend)
- GitHub Actions CI — раздельные пайплайны для backend/frontend, порог покрытия тестами ≥75%

---

<a id="-архитектура"></a>

## 🏗️ Архитектура

```
Загрузка (frontend) -> POST /internal/documents -> StorageAdapter (диск)
                                                  -> запись в documents (status: uploaded)
                                                  -> задача в очереди Celery через Redis
                                                          |
                                                          v
                                              Redis (брокер Celery)
                                                          |
                                                          v
Celery-воркер: извлечение текста (pypdf/docx) -> разбиение на чанки по
абзацам (~1500 символов, с fallback-разбиением по предложениям для
слишком длинных абзацев) -> эмбеддинг каждого чанка (OpenAI Embeddings
API) -> запись чанков и векторов в Postgres -> статус: chunking -> ready
(либо failed, с записью события об ошибке)
                                                          |
                                                          v
Чат: POST /internal/chat/messages -> поиск top-K похожих чанков через
косинусное сходство pgvector по всем документам со статусом "ready" ->
передача найденного контекста в OpenAI chat-модель -> ответ сохраняется
вместе с сообщением пользователя
```

Redis стоит между API и Celery-воркером исключительно как **брокер**
задач (транспорт для постановки job'ов в очередь) — result backend у
Celery не настроен. Результаты задач (переходы статуса, запись
чанков/векторов) пишутся напрямую в Postgres и никогда не читаются
обратно из Redis, поэтому сам брокер остаётся легко заменяемым (например,
на RabbitMQ) — чисто через конфигурацию, без изменений архитектуры.

Каждое событие пайплайна/чата пишется в таблицу `dashboard_events`.
Встроенный дашборд читает данные напрямую из Postgres, показывая журнал
событий, графики использования с привязкой к календарю (сообщения/дизлайки
по дням/неделям/месяцам/годам), 3D UMAP-проекцию всех эмбеддингов чанков
(сгруппированных/связанных по исходному документу), а также — если
настроен **Admin**-ключ OpenAI — панель расходов и токенов на уровне
организации.

Эндпоинт `getTopMatchingChunks`/`top-chunks` предоставляет тот же самый шаг
поиска напрямую (страница "Relevance Preview") для проверки результатов
семантического поиска без обращения к LLM.

> **Заметка:** слой аутентификации пока не реализован — приложение
> рассчитано на локальное/внутреннее использование в текущем виде.

---

<a id="-api-эндпоинты"></a>

## 🔌 API-эндпоинты

Интерактивная документация (Swagger UI) включена по умолчанию —
**http://localhost:8000/docs** (ReDoc на `/redoc`, сырая OpenAPI-схема на
`/openapi.json`) — это полный и всегда актуальный источник истины. Ниже —
сводка по модулям; все пути с префиксом `/internal`, кроме `/health`.

**Documents**
| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/documents` | Загрузка документа (multipart; поле формы `overwrite` для замены существующего) |
| `GET` | `/documents` | Список всех документов |
| `DELETE` | `/documents/{id}` | Удаление документа и его файла |

**Chunks**
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/documents/{id}/chunks` | Получить чанки документа |
| `POST` | `/documents/{id}/chunks` | Сохранить отредактированные чанки, запускает пере-чанкинг/пере-эмбеддинг (202) |

**Chat**
| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/chat/messages` | Отправить сообщение, получить ответ LLM |
| `GET` | `/chat/messages` | История чата |
| `POST` | `/chat/messages/{id}/dislike` | Переключить дизлайк на сообщении |
| `POST` | `/chat/top-chunks` | Relevance preview — топ-5 подходящих чанков, без вызова LLM |

**Dashboard**
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/dashboard/events` | Журнал событий пайплайна/чата |
| `GET` | `/dashboard/stats` | Статистика использования (query: `range`, `tz`) |
| `GET` | `/dashboard/chunk-graph` | 3D UMAP-проекция всех эмбеддингов чанков |
| `GET` | `/dashboard/openai-spend` | Расход/использование токенов OpenAI на уровне организации |

**Прочее**
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/internal/db-check` | Проверка соединения с БД |
| `POST` | `/internal/smoke-job` | Создать внутреннюю smoke-test задачу |
| `GET` | `/internal/smoke-job/{id}` | Статус smoke-test задачи |

---

<a id="-структура-проекта"></a>

## 📁 Структура проекта

Backend-код организован по одному самодостаточному модулю на каждую
таблицу БД (роутер + схемы + бизнес-логика вместе), а не по
горизонтальным слоям — см. каждый модуль ниже.

```
DocuMind/
├── backend/
│   ├── app/
│   │   ├── documents/     загрузка/список/удаление, извлечение текста,
│   │   │                  хранилище, пайплайн парсинг->чанкинг->эмбеддинг,
│   │   │                  его Celery-задача
│   │   ├── chunks/        роутер чанков, разбиение, эмбеддинг, векторы,
│   │   │                  поиск по схожести
│   │   ├── chat/          сообщения, дизлайк, top-chunks, генерация ответа
│   │   ├── dashboard_events/  CRUD таблицы dashboard_events
│   │   ├── dashboard/     stats/chunk-graph/openai-spend (без своей
│   │   │                  таблицы — вынесены отдельно от событий выше)
│   │   ├── smoke_jobs/    внутренняя health-check задача
│   │   ├── db/            session (async), sync_session (Alembic/Celery)
│   │   ├── worker/        celery_app (общий инстанс Celery)
│   │   ├── main.py        фабрика FastAPI, подключает роутеры всех модулей
│   │   └── config.py      Settings (настройки из env)
│   ├── alembic/           миграции схемы
│   └── tests/
├── frontend/
│   └── src/
│       ├── pages/         Upload, Chunk review, Chat, Relevance, Dashboard
│       └── api/           ApiClient (реальный HTTP-клиент + офлайн-мок)
├── docker-compose.yml
└── .github/workflows/     CI (backend-ci.yml, frontend-ci.yml)
```

---

<a id="-быстрый-старт"></a>

## 🚀 Быстрый старт

**Требования:** Docker + Docker Compose, ключ OpenAI API (опционально — без
него чанкинг документов будет корректно завершаться ошибкой, а чат
отвечать 502, но всё остальное продолжит работать).

```bash
git clone <repo-url>
cd DocuMind
cp .env.example .env        # укажите OPENAI_API_KEY (и опционально OPENAI_ADMIN_API_KEY)
docker compose up -d --build
docker compose exec backend alembic upgrade head   # только при первом запуске
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:8000 (health-check: `GET /health`)

Frontend подхватывает изменения на лету через Vite. Backend и worker —
**нет**: после изменений в коде backend нужно пересобрать:

```bash
docker compose up -d --build backend worker
```

**Запуск тестов локально**

```bash
# Backend (нужен доступный Postgres+pgvector и Redis через
# DATABASE_URL / DATABASE_URL_SYNC / CELERY_BROKER_URL)
cd backend && pytest tests/ --cov=app --cov-fail-under=75

# Frontend
cd frontend && npm ci && npm test -- --coverage
```

CI прогоняет оба набора тестов на каждый pull request и push в `main`, и
блокирует сборку, если покрытие падает ниже 75%.
