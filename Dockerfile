# Stage 1: the Expo web build. Compiled with same-origin so the served page
# talks to the Django app it came from -- no CORS, no hardcoded hostname.
FROM node:22-slim AS web
WORKDIR /build
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/ ./
ENV EXPO_PUBLIC_API_URL=same-origin
RUN npx expo export --platform web

# Stage 2: Django, serving both the API and that build.
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libpq5 \
 && rm -rf /var/lib/apt/lists/*

COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ .
COPY --from=web /build/dist ./webroot

RUN SECRET_KEY=build DEBUG=0 python manage.py collectstatic --noinput

# Migrations run here, NOT as a Fly release_command: release machines do not get
# volumes mounted, so a release-command migrate would build a throwaway database
# and leave /data untouched. One machine holds the volume, so there is no
# concurrent-migration race.
CMD ["sh", "-c", "python manage.py migrate --noinput && exec gunicorn babylog.wsgi --bind 0.0.0.0:8080 --workers 2 --threads 4"]
