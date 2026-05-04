# ============================================================
# Dockerfile - Mayar Billing System
# ============================================================

# Base image Node.js ringan (Alpine)
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files dulu (untuk cache layer)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy semua source code
COPY . .

# Expose port
EXPOSE 3000

# Jalankan aplikasi
CMD ["node", "index.js"]
