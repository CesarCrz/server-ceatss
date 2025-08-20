# Usa una imagen base de Node.js (la misma que tu otro proyecto)
FROM node:21-alpine3.18 as deploy

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos de configuración de npm
COPY package*.json ./

# Habilita y usa pnpm para instalar las dependencias
RUN corepack enable && corepack prepare pnpm@latest --activate \
    && npm cache clean --force && pnpm install --production --ignore-scripts

#para instalar y configurar chromium
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont

# Copia el resto del código de la aplicación
COPY . .

# Expone el puerto donde se ejecuta la aplicación
EXPOSE 3000

# Define el comando para iniciar la aplicación.
# Asume que tu 'package.json' tiene un script llamado 'start'
# que ejecuta 'node backend/src/server.js'
CMD ["npm", "start"]
