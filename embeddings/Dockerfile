FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    EMBEDDING_HOST=0.0.0.0 \
    EMBEDDING_PORT=8080 \
    EMBEDDING_CACHE_DIR=/cache

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8080

CMD ["python", "app.py"]
