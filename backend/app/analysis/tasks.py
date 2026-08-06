import asyncio

from app.analysis.service import run_full_analysis
from app.worker.celery_app import celery_app


@celery_app.task(name="run_documentation_analysis")
def run_documentation_analysis(report_id: str) -> None:
    """Sync Celery entrypoint - see run_full_analysis's own docstring for
    the actual pipeline; this is just the asyncio.run() bridge, same shape
    as documents/tasks.py's run_document_pipeline wrapping run_pipeline."""
    asyncio.run(run_full_analysis(report_id))
