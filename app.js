require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

// Initialize app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.set('trust proxy', 1); // Trust first proxy for HTTPS
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'ai-concierge-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Original routes (for backward compatibility)
app.use('/', require('./routes/auth'));
app.use('/webhook', require('./routes/webhook')); 

// Explicitly register known client routes
app.use('/clients/barbershop/webhook', require('./routes/clients/barbershop/webhook'));
app.use('/clients/justin/webhook', require('./routes/clients/justin/webhook'));

// Check if makeup-artist webhook exists and register it
const makeupArtistWebhook = path.join(__dirname, 'routes', 'clients', 'makeup-artist', 'webhook.js');
if (fs.existsSync(makeupArtistWebhook)) {
  app.use('/clients/makeup-artist/webhook', require('./routes/clients/makeup-artist/webhook'));
  console.log('Loaded makeup-artist webhook route');
}

// Dynamically load any additional client-specific webhook routes
const clientsDir = path.join(__dirname, 'routes', 'clients');

// Check if the clients directory exists
if (fs.existsSync(clientsDir)) {
  // Read all directories in the clients directory
  const clients = fs.readdirSync(clientsDir).filter(file => {
    return fs.statSync(path.join(clientsDir, file)).isDirectory();
  });

  // Register each client's webhook routes (skipping the ones we explicitly registered)
  clients.forEach(client => {
    if (client !== 'barbershop' && client !== 'justin' && client !== 'makeup-artist') {
      const webhookPath = path.join(clientsDir, client, 'webhook.js');
      if (fs.existsSync(webhookPath)) {
        console.log(`Loading webhook routes for client: ${client}`);
        app.use(`/clients/${client}/webhook`, require(webhookPath));
      }
    }
  });
}

// Home route - serves the generic landing page
app.get('/', (req, res) => {
  res.render('index');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Application error:', err);
  res.status(err.status || 500).render('error', {
    message: err.message || 'An unexpected error occurred',
    error: process.env.NODE_ENV === 'development' ? err : {}
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`- Visit homepage: http://localhost:${PORT}`);
  console.log(`- Barbershop webhook: http://localhost:${PORT}/clients/barbershop/webhook`);
  console.log(`- Justin webhook: http://localhost:${PORT}/clients/justin/webhook`);
  console.log(`- Makeup Artist webhook: http://localhost:${PORT}/clients/makeup-artist/webhook`);
});