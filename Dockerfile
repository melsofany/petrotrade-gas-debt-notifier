# Updated Dockerfile

# Base image
FROM node:14

# Set the working directory
WORKDIR /app

# Install dependencies using npm ci with fallback to npm install
COPY package*.json ./
RUN npm ci || npm install

# Install system dependencies with --no-install-recommends
RUN apt-get update && apt-get install --no-install-recommends -y <system_dependencies> \ 
    && apt-get clean \ 
    && rm -rf /var/lib/apt/lists/*

# Copy the rest of the application code
COPY . .

# Start the application
CMD [ "npm", "start" ]