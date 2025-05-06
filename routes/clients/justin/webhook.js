const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const config = require('./config');
const { supabase, barberOps, clientOps, appointmentOps } = require('../../../utils/supabase/clients/justin');

// Create a Justin-specific OAuth2 client
const createJustinOAuth2Client = async () => {
  const refreshToken = await barberOps.getJustinRefreshToken();
  
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
};

// Justin's appointment endpoint
router.post('/appointment', async (req, res) => {
  const {
    clientIdentifier,
    platform,
    clientName,
    serviceType = 'haircut',
    startDateTime,
    duration = 30,
    action = 'create'
  } = req.body;
  
  // Validate required fields
  if (!clientIdentifier || !platform) {
    return res.status(400).json({
      success: false,
      error: 'Client identifier and platform are required'
    });
  }
  
  // Validate Thursday constraint for creating appointments
  if (!config.isValidThursdayTime(startDateTime) && action === 'create') {
    return res.status(400).json({
      success: false,
      error: 'Justin only works Thursdays 1-5 PM'
    });
  }
  
  try {
    const oauth2Client = await createJustinOAuth2Client();
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    const startTime = new Date(startDateTime);
    const endTime = new Date(startTime.getTime() + (duration * 60000));
    
    let result;
    
    switch (action) {
      case 'create':
        const eventDetails = {
          summary: `${serviceType}: ${clientName}`,
          description: `Client: ${clientName}\nPlatform: ${platform}\nID: ${clientIdentifier}`,
          start: { dateTime: startTime.toISOString(), timeZone: config.calendar.timeZone },
          end: { dateTime: endTime.toISOString(), timeZone: config.calendar.timeZone }
        };
        
        const event = await calendar.events.insert({ 
          calendarId: config.calendar.calendarId, 
          resource: eventDetails,
          sendUpdates: 'all'
        });
        
        // Store in DB
        await appointmentOps.create({
          client_identifier: clientIdentifier,
          platform: platform,
          service_type: serviceType,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          google_calendar_event_id: event.data.id,
          client_name: clientName
        });
        
        result = { 
          success: true, 
          action: 'create',
          eventId: event.data.id,
          eventLink: event.data.htmlLink 
        };
        break;
        
      case 'cancel':
        if (!req.body.eventId) {
          return res.status(400).json({
            success: false,
            error: 'Event ID is required for cancellation'
          });
        }
        
        // Cancel in Google Calendar
        await calendar.events.delete({
          calendarId: config.calendar.calendarId,
          eventId: req.body.eventId,
          sendUpdates: 'all'
        });
        
        // Delete from database
        await appointmentOps.cancelAppointment(req.body.eventId);
        
        result = {
          success: true,
          action: 'cancel',
          eventId: req.body.eventId
        };
        break;
        
      case 'reschedule':
        if (!req.body.eventId) {
          return res.status(400).json({
            success: false,
            error: 'Event ID is required for rescheduling'
          });
        }
        
        // Validate the new time for Thursday constraint
        if (!config.isValidThursdayTime(startDateTime)) {
          return res.status(400).json({
            success: false,
            error: 'Justin only works Thursdays 1-5 PM'
          });
        }
        
        // Get the existing event
        const existingEvent = await calendar.events.get({
          calendarId: config.calendar.calendarId,
          eventId: req.body.eventId
        });
        
        // Update the event
        const updatedEvent = await calendar.events.update({
          calendarId: config.calendar.calendarId,
          eventId: req.body.eventId,
          resource: {
            ...existingEvent.data,
            summary: `${serviceType}: ${clientName}`,
            start: { dateTime: startTime.toISOString(), timeZone: config.calendar.timeZone },
            end: { dateTime: endTime.toISOString(), timeZone: config.calendar.timeZone }
          },
          sendUpdates: 'all'
        });
        
        result = {
          success: true,
          action: 'reschedule',
          eventId: updatedEvent.data.id,
          eventLink: updatedEvent.data.htmlLink
        };
        break;
        
      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid action specified'
        });
    }
    
    return res.status(200).json(result);
  } catch (error) {
    console.error('Justin appointment error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Get Justin's availability
router.get('/thursday-slots', async (req, res) => {
  const { date, duration = 30 } = req.query;
  
  try {
    const oauth2Client = await createJustinOAuth2Client();
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Get the Thursday if date provided
    const targetDate = date ? new Date(date) : getNextThursday();
    
    // Set to 1 PM (13:00)
    targetDate.setHours(config.availability.startHour, 0, 0, 0);
    
    const timeMin = new Date(targetDate);
    const timeMax = new Date(targetDate);
    timeMax.setHours(config.availability.endHour, 0, 0, 0); // 5 PM
    
    const events = await calendar.events.list({
      calendarId: config.calendar.calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    
    // Find available slots
    const slots = findAvailableSlots(events.data.items, timeMin, timeMax, duration);
    
    return res.status(200).json({
      success: true,
      date: targetDate.toISOString().split('T')[0],
      slots: slots,
      duration: duration,
      location: config.availability.location
    });
  } catch (error) {
    console.error('Error getting Thursday slots:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Helper function to get next Thursday
function getNextThursday() {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const daysUntilThursday = (4 - dayOfWeek + 7) % 7 || 7;
  const nextThursday = new Date(today);
  nextThursday.setDate(today.getDate() + daysUntilThursday);
  return nextThursday;
}

// Helper function to find available slots
function findAvailableSlots(events, startTime, endTime, duration) {
  const slots = [];
  let currentTime = new Date(startTime);
  
  while (currentTime < endTime) {
    const slotEnd = new Date(currentTime.getTime() + (duration * 60000));
    
    if (slotEnd > endTime) break;
    
    const isAvailable = !events.some(event => {
      const eventStart = new Date(event.start.dateTime);
      const eventEnd = new Date(event.end.dateTime);
      return (currentTime < eventEnd && slotEnd > eventStart);
    });
    
    if (isAvailable) {
      slots.push({
        start: currentTime.toISOString(),
        end: slotEnd.toISOString()
      });
    }
    
    currentTime = new Date(currentTime.getTime() + (duration * 60000));
  }
  
  return slots;
}

// Get client by identifier and platform
router.get('/get-client', async (req, res) => {
  const { identifier, platform } = req.query;
  
  if (!identifier || !platform) {
    return res.status(400).json({ success: false, error: 'Missing identifier or platform' });
  }
  
  const client = await clientOps.getByPlatformId(identifier, platform);
  
  return res.status(200).json({
    success: true,
    found: !!client,
    client: client
  });
});

// Create client for Justin
router.post('/create-client', async (req, res) => {
  const { identifier, platform, name } = req.body;
  
  if (!identifier || !platform) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  
  const client = await clientOps.createClient({
    identifier: identifier,
    platform: platform,
    name: name || 'New Client'
  });
  
  if (!client) {
    return res.status(500).json({ success: false, error: 'Failed to create client' });
  }
  
  return res.status(200).json({
    success: true,
    client: client
  });
});

// Get available services
router.get('/services', (req, res) => {
  return res.status(200).json({
    success: true,
    services: config.services
  });
});

module.exports = router;