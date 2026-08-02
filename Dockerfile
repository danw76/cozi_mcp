# Self-hosted Streamable HTTP deployment (Railway, Fly, any container host).
# Builds the bundled dist/ with tsup, then ships a slim runtime image that runs
# the HTTP entry point. See docs/DEPLOY-RAILWAY.md for the full walkthrough.

# ---- build stage ----------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

# Install all deps (incl. dev) against the lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

# Build dist/http-server.js (+ server.js, bin.js) from source.
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# ---- runtime stage --------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tsup bundles all runtime deps into dist/*, so the runtime image needs only
# the built output — no node_modules install.
COPY --from=build /app/dist ./dist
COPY package.json ./

# Railway/other platforms inject $PORT; the server reads it (defaults to 8080).
ENV PORT=8080
EXPOSE 8080

# Run as the non-root user that the base image already provides.
USER node

CMD ["node", "dist/http-server.js"]
