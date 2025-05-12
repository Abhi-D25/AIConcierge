const express = require('express');
const router = express.Router();
const { google } = require('googleapis');

// Import Supabase client creator
const { createClient } = require('@supabase/supabase-js');

// Import multiple Supabase clients
const { createSupabaseClient, createClientOperations } = require('../utils/supabase/base');

// Regular barber shop operations
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createSupabaseClient(supabaseUrl, supabaseKey);
const { barberOps } = createClientOperations(supabase);

// Makeup artist operations - using a separate Supabase database
const makeupArtistUrl = process.env.MAKEUP_ARTIST_SUPABASE_URL || process.env.SUPABASE_URL;
const makeupArtistKey = process.env.MAKEUP_ARTIST_SUPABASE_KEY || process.env.SUPABASE_KEY;
const makeupArtistSupabase = createClient(makeupArtistUrl, makeupArtistKey);

// Set up OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// Google login route
router.get('/auth/google', (req, res) => {
  // Store registration info in session
  if (req.query.phone) {
    req.session.phoneNumber = req.query.phone;
  }
  
  if (req.query.name) {
    req.session.registrantName = req.query.name;
  }
  
  if (req.query.email) {
    req.session.email = req.query.email;
  }
  
  if (req.query.service_type) {
    req.session.serviceType = req.query.service_type;
  }
  
  if (req.query.business_type) {
    req.session.businessType = req.query.business_type;
  }

  // Generate authentication URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
      'profile',
      'email'
    ],
    prompt: 'consent' // Force to get refresh token
  });

  res.redirect(authUrl);
});

// Callback route after Google authentication
router.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  
  try {
    // Exchange authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // Get user profile information
    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: 'v2'
    });
    
    const { data } = await oauth2.userinfo.get();
    
    // Get list of calendars for selection
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarList = await calendar.calendarList.list();
    
    // Store user information in session
    req.session.googleEmail = data.email;
    req.session.refreshToken = tokens.refresh_token;
    req.session.calendars = calendarList.data.items.map(cal => ({
      id: cal.id,
      summary: cal.summary
    }));
    
    // If we have a phone number in session, we can update the account
    if (req.session.phoneNumber) {
      // Use the name from the registration form (stored in session) instead of Google account
      const registrantName = req.session.registrantName || data.name;
      const businessType = req.session.businessType || 'barber';
      const serviceType = req.session.serviceType || 'barber';
      const registrantEmail = req.session.email || data.email;
      
      console.log('Processing registration for:', {
        name: registrantName,
        businessType: businessType,
        serviceType: serviceType,
        email: registrantEmail
      });
      
      // Only use makeup artist database for makeup artists
      if (serviceType === 'makeup_artist' && businessType === 'makeup_artist') {
        console.log('Updating makeup artist with Google credentials:', registrantName);
        
        // Use makeup artist Supabase client
        try {
          // First check if the artist already exists
          const { data: existingArtist, error: findError } = await makeupArtistSupabase
            .from('makeup_artists')
            .select('id')
            .eq('phone_number', req.session.phoneNumber)
            .single();
            
          if (findError && findError.code !== 'PGRST116') {
            console.error('Error finding existing makeup artist:', findError);
          }
          
          let artistOperation;
          if (existingArtist) {
            // Update existing record with Google OAuth details
            artistOperation = makeupArtistSupabase
              .from('makeup_artists')
              .update({
                name: registrantName,
                email: registrantEmail,
                refresh_token: tokens.refresh_token,
                updated_at: new Date()
              })
              .eq('phone_number', req.session.phoneNumber)
              .select();
          } else {
            // Create new record with all details
            artistOperation = makeupArtistSupabase
              .from('makeup_artists')
              .insert({
                phone_number: req.session.phoneNumber,
                name: registrantName,
                email: registrantEmail,
                refresh_token: tokens.refresh_token,
                business_hours_start: '09:00',
                business_hours_end: '18:00',
                created_at: new Date(),
                updated_at: new Date()
              })
              .select();
          }
          
          // Execute the appropriate operation
          const { data: artist, error } = await artistOperation;
          
          if (error) {
            console.error('Error updating makeup artist record:', error);
            return res.render('error', { 
              message: 'Failed to update your account. Please try again.' 
            });
          }
          
          console.log('Successfully updated makeup artist with Google credentials:', artist);
        } catch (err) {
          console.error('Exception while updating makeup artist:', err);
          return res.render('error', { 
            message: 'An error occurred while setting up your account. Please try again.' 
          });
        }
      } else {
        // For all other business types (barber, beauty_salon, etc.)
        console.log('Creating/updating barber with credentials:', registrantName);
        
        // Use regular barber shop operations
        const barber = await barberOps.updateOrCreate({
          phone_number: req.session.phoneNumber,
          name: registrantName,
          email: registrantEmail,
          refresh_token: tokens.refresh_token,
          business_type: businessType // Store the business type
        });
        
        if (!barber) {
          console.error('Failed to create barber account');
          return res.render('error', { 
            message: 'Failed to create your account. Please try again.' 
          });
        }
        
        console.log('Successfully created/updated barber account:', barber.id);
      }
    } else {
      // Display a message that phone number is required
      console.error('No phone number provided for registration');
      return res.render('error', { 
        message: 'Phone number is required for registration. Please start again with a phone number.' 
      });
    }
    
    // Redirect to calendar selection page
    res.redirect('/select-calendar');
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.render('error', { message: 'Authentication failed. Please try again.' });
  }
});

// Calendar selection page
router.get('/select-calendar', (req, res) => {
  if (!req.session.calendars || !req.session.phoneNumber) {
    return res.redirect('/auth/google');
  }
  
  res.render('select-calendar', { 
    calendars: req.session.calendars,
    phoneNumber: req.session.phoneNumber,
    serviceType: req.session.serviceType || 'barber'
  });
});

// Save selected calendar
router.post('/save-calendar', async (req, res) => {
  const { calendarId } = req.body;
  const phoneNumber = req.session.phoneNumber;
  const serviceType = req.session.serviceType || 'barber';
  const businessType = req.session.businessType || 'barber';
  
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  
  try {
    // Save calendar ID to appropriate database based on service type
    if (serviceType === 'makeup_artist' && businessType === 'makeup_artist') {
      // Update makeup artist's selected calendar in Supabase
      const { data, error } = await makeupArtistSupabase
        .from('makeup_artists')
        .update({ 
          selected_calendar_id: calendarId,
          updated_at: new Date()
        })
        .eq('phone_number', phoneNumber)
        .select();
      
      if (error || !data || data.length === 0) {
        console.error('Error updating makeup artist calendar:', error);
        return res.status(404).json({ error: 'Makeup artist not found' });
      }
    } else {
      // Update barber's selected calendar
      const updatedBarber = await barberOps.updateCalendarId(phoneNumber, calendarId);
      
      if (!updatedBarber) {
        return res.status(404).json({ error: 'Barber not found' });
      }
    }
    
    // Render success page
    res.render('success', { serviceType: serviceType, businessType: businessType });
    
  } catch (error) {
    console.error('Save calendar error:', error);
    res.status(500).json({ error: 'Failed to save calendar preference' });
  }
});

// Manual registration form route
router.get('/register', (req, res) => {
  res.render('register');
});

// Handle manual registration
router.post('/register', async (req, res) => {
  let { name, phoneNumber, email, businessType, service_type } = req.body;
  
  if (!phoneNumber) {
    return res.render('error', { message: 'Phone number is required' });
  }
  
  // Clean phone number - remove any formatting
  phoneNumber = phoneNumber.replace(/\D/g, '');
  
  // Ensure phone number has +1 prefix for US numbers
  if (phoneNumber.length === 10) {
    phoneNumber = '+1' + phoneNumber;
  } else if (!phoneNumber.startsWith('+')) {
    phoneNumber = '+' + phoneNumber;
  }
  
  try {
    // Store data in session for use during Google OAuth flow
    req.session.phoneNumber = phoneNumber;
    req.session.registrantName = name;
    req.session.email = email;
    req.session.businessType = businessType || 'makeup_artist';
    req.session.serviceType = service_type || 'makeup_artist';
    
    // For makeup artists, we'll wait to create the record until after OAuth
    if (service_type === 'makeup_artist' || businessType === 'makeup_artist') {
      // Skip pre-creation, just store in session and proceed to OAuth
      console.log('Proceeding to OAuth for makeup artist registration:', name);
    } else {
      // Use barber operations for pre-creation
      await barberOps.updateOrCreate({
        phone_number: phoneNumber,
        name: name,
        email: email
      });
    }
    
    res.redirect('/auth/google');
  } catch (error) {
    console.error('Registration error:', error);
    res.render('error', { message: 'Registration failed. Please try again.' });
  }
});

module.exports = router;