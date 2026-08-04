# DocuMind

<p align="center">
  <b>Lang:</b>
  <a href="README.md"><img alt="ENG" src="https://img.shields.io/badge/ENG-0366d6?style=for-the-badge"></a>
  <img alt="RUS" src="https://img.shields.io/badge/RUS-2ea44f?style=for-the-badge">
</p>

DocuMind — self-hosted RAG (Retrieval-Augmented Generation) ассистент для
работы с документацией. Загружайте PDF/DOCX документы, они автоматически
парсятся и разбиваются на чанки, которые можно просмотреть и отредактировать,
после чего можно общаться с LLM, которая отвечает, опираясь на найденный
контекст из ваших документов. Встроенный дашборд показывает журнал событий
пайплайна, статистику использования и 3D-визуализацию эмбеддингов чанков.

## Скриншоты

| Загрузка | Просмотр чанков |
|---|---|
| ![Страница загрузки](docs/images/upload.png) | ![Просмотр чанков](docs/images/chunks.png) |

| Чат | Дашборд |
|---|---|
| ![Страница чата](docs/images/chat.png) | ![Дашборд](docs/images/dashboard.png) |

## Стек технологий

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

## Архитектура

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

Слой аутентификации пока не реализован — приложение рассчитано на
локальное/внутреннее использование в текущем виде.

## Структура проекта

```
DocuMind/
├── backend/
│   ├── app/
│   │   ├── routers/       documents, chat, dashboard (API-эндпоинты)
│   │   ├── services/      documents (парсинг), pipeline (чанкинг+эмбеддинг),
│   │   │                  llm (клиент OpenAI), vectors, events, storage
│   │   ├── worker/        celery_app, tasks (точки входа Celery-задач)
│   │   ├── db/            session (async), sync_session (Alembic/Celery)
│   │   ├── prompts/       системный промпт чата
│   │   ├── main.py        фабрика FastAPI-приложения
│   │   ├── config.py      Settings (настройки из env)
│   │   └── deps.py        DI-провайдеры (например, get_storage)
│   ├── alembic/           миграции схемы
│   └── tests/
├── frontend/
│   └── src/
│       ├── pages/         Upload, Chunk review, Chat, Relevance, Dashboard
│       └── api/           ApiClient (реальный HTTP-клиент + офлайн-мок)
├── docker-compose.yml
└── .github/workflows/     CI (backend-ci.yml, frontend-ci.yml)
```

## Быстрый старт

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
