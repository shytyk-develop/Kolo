# the frontend as it runs on Vercel: a production build, talking to the lab's api
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 BACKEND_URL=http://10.77.0.11:8000 NEXT_PUBLIC_API_URL=https://api.kolo.lab
RUN npm run build
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
