FROM node:22-alpine AS deps

WORKDIR /app/repos/jormungand
COPY repos/jormungand/package.json repos/jormungand/package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder

WORKDIR /app/repos/jormungand
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/repos/jormungand/node_modules ./node_modules
COPY repos/jormungand ./
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app/repos/jormungand
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/repos/jormungand ./
EXPOSE 3000
CMD ["sh", "-c", "npm run start -- --port ${PORT:-3000}"]
