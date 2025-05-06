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
    clientPhone,
    clientName,
    serviceType = 'haircut',
    startDateTime,
    duration = 30,
    preferredBarberId,
    eventId,
    newStartDateTime,
    isRescheduling = false,
    isCancelling = false
  } = req.body;
  
  // Validate required fields
  if (!clientPhone) {
    return res.status(400).json({
      success: false,
      error: 'Client phone number is required'
    });
  }
  
  // Determine the action based on the flags
  let action = 'create';
  if (isRescheduling) action = 'reschedule';
  if (isCancelling) action = 'cancel';
  
  // For creation and rescheduling, validate Thursday constraint
  if ((action === 'create' || action === 'reschedule') && 
      !config.isValidThursdayTime(action === 'reschedule' ? newStartDateTime : startDateTime)) {
    return res.status(400).json({
      success: false,
      error: 'Justin only works Thursdays 1-5 PM'
    });
  }
  
  try {
    const oauth2Client = await createJustinOAuth2Client();
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Use appropriate start time based on action
    const startTime = new Date(action === 'reschedule' ? newStartDateTime : startDateTime);
    const endTime = new Date(startTime.getTime() + (duration * 60000));
    
    let result;
    
    switch (action) {
      case 'create':
        const eventDetails = {
          summary: `${serviceType}: ${clientName}`,
          description: `Client: ${clientName}\nPhone: ${clientPhone}\nBarber: ${preferredBarberId || 'JUSTIN_BARBER_ID'}`,
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
          client_identifier: clientPhone,
          platform: 'phone',
          service_type: serviceType,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          google_calendar_event_id: event.data.id,
          client_name: clientName,
          barber_id: preferredBarberId || 'JUSTIN_BARBER_ID'
        });
        
        result = { 
          success: true, 
          action: 'create',
          eventId: event.data.id,
          eventLink: event.data.htmlLink 
        };
        break;
        
      case 'cancel':
        if (!eventId) {
          return res.status(400).json({
            success: false,
            error: 'Event ID is required for cancellation'
          });
        }
        
        // Cancel in Google Calendar
        await calendar.events.delete({
          calendarId: config.calendar.calendarId,
          eventId: eventId,
          sendUpdates: 'all'
        });
        
        // Delete from database
        await appointmentOps.cancelAppointment(eventId);
        
        result = {
          success: true,
          action: 'cancel',
          eventId: eventId
        };
        break;
        
      case 'reschedule':
        if (!eventId || !newStartDateTime) {
          return res.status(400).json({
            success: false,
            error: 'Event ID and new start time are required for rescheduling'
          });
        }
        
        // Get the existing event
        const existingEvent = await calendar.events.get({
          calendarId: config.calendar.calendarId,
          eventId: eventId
        });
        
        // Update the event
        const updatedEvent = await calendar.events.update({
          calendarId: config.calendar.calendarId,
          eventId: eventId,
          resource: {
            ...existingEvent.data,
            summary: `${serviceType}: ${clientName}`,
            start: { dateTime: startTime.toISOString(), timeZone: config.calendar.timeZone },
            end: { dateTime: endTime.toISOString(), timeZone: config.calendar.timeZone }
          },
          sendUpdates: 'all'
        });
        
        // Update in database
        await appointmentOps.updateAppointment(eventId, {
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString()
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

// Get barber's availability
router.get('/thursday-slots', async (req, res) => {
  const { 
    barberId = 'JUSTIN_BARBER_ID',
    startDateTime,
    endDateTime,
    findNextAvailable = false,
    numSlots = 2,
    serviceDuration = 30 
  } = req.query;
  
  try {
    const oauth2Client = await createJustinOAuth2Client();
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Get date range to check
    let timeMin, timeMax;
    
    if (startDateTime && endDateTime) {
      timeMin = new Date(startDateTime);
      timeMax = new Date(endDateTime);
    } else if (findNextAvailable) {
      // Find next available Thursday
      const targetDate = getNextThursday();
      timeMin = new Date(targetDate);
      timeMin.setHours(config.availability.startHour, 0, 0, 0); // 1 PM
      
      timeMax = new Date(targetDate);
      timeMax.setHours(config.availability.endHour, 0, 0, 0); // 5 PM
    } else {
      // Default to next Thursday
      const targetDate = getNextThursday();
      timeMin = new Date(targetDate);
      timeMin.setHours(config.availability.startHour, 0, 0, 0); // 1 PM
      
      timeMax = new Date(targetDate);
      timeMax.setHours(config.availability.endHour, 0, 0, 0); // 5 PM
    }
    
    const events = await calendar.events.list({
      calendarId: config.calendar.calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    
    // Find available slots
    let allSlots = findAvailableSlots(events.data.items, timeMin, timeMax, parseInt(serviceDuration));
    
    // Limit to requested number of slots if specified
    if (numSlots > 0 && allSlots.length > numSlots) {
      allSlots = allSlots.slice(0, numSlots);
    }
    
    return res.status(200).json({
      success: true,
      barberId: barberId,
      date: timeMin.toISOString().split('T')[0],
      slots: allSlots,
      serviceDuration: parseInt(serviceDuration),
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

// Get client by phone number
router.get('/get-client', async (req, res) => {
  const { phoneNumber } = req.query;
  
  if (!phoneNumber) {
    return res.status(400).json({ success: false, error: 'Missing phone number' });
  }
  
  const client = await clientOps.getByPlatformId(phoneNumber, 'phone');
  
  return res.status(200).json({
    success: true,
    found: !!client,
    client: client
  });
});

// Create client for Justin
router.post('/create-client', async (req, res) => {
  const { phoneNumber, name } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ success: false, error: 'Missing phone number' });
  }
  
  const client = await clientOps.createClient({
    identifier: phoneNumber,
    platform: 'phone',
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