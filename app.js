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
  secret: process.env.SESSION_SECRET,
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

// Original routes
app.use('/', require('./routes/auth'));
app.use('/webhook', require('./routes/webhook')); // Keep for backward compatibility

// Dynamically load client-specific webhook routes
const clientsDir = path.join(__dirname, 'routes', 'clients');

// Check if the clients directory exists
if (fs.existsSync(clientsDir)) {
  // Read all directories in the clients directory
  const clients = fs.readdirSync(clientsDir).filter(file => {
    return fs.statSync(path.join(clientsDir, file)).isDirectory();
  });

  // Register each client's webhook routes
  clients.forEach(client => {
    const webhookPath = path.join(clientsDir, client, 'webhook.js');
    if (fs.existsSync(webhookPath)) {
      console.log(`Loading webhook routes for client: ${client}`);
      app.use(`/clients/${client}/webhook`, require(webhookPath));
    }
  });
}

// Home route
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
});