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
  
  // Format the duration if it's a string
  const serviceDuration = typeof duration === 'string' ? parseInt(duration, 10) : duration;
  
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
  
  try {
    // For creation and rescheduling, validate the time
    if ((action === 'create' || action === 'reschedule') && !isCancelling) {
      const dateTimeStr = action === 'reschedule' ? newStartDateTime : startDateTime;
      
      // Extract date and time parts directly from string
      const datePart = dateTimeStr.split('T')[0]; // "2025-05-16"
      const timePart = dateTimeStr.split('T')[1].split(/[-+Z]/)[0]; // "15:00:00"
      const hour = parseInt(timePart.split(':')[0], 10); // 15
      
      // Extract day of week from date
      const [year, month, day] = datePart.split('-').map(n => parseInt(n, 10));
      const dateObj = new Date(year, month - 1, day); // Month is 0-indexed
      const dayOfWeek = dateObj.getDay(); // 0-6 (Sunday-Saturday)
      
      // Validate against business hours
      let isValidTime = false;
      if (dayOfWeek === 4) { // Thursday
        isValidTime = hour >= 18 && hour < 22; // 6 PM - 10 PM
      } else if (dayOfWeek === 5) { // Friday
        isValidTime = hour >= 14 && hour < 20; // 2 PM - 8 PM
      }
      
      if (!isValidTime) {
        return res.status(400).json({
          success: false,
          error: 'Justin only works on Thursday from 6 PM to 10 PM and Friday from 2 PM to 8 PM',
          debug: {
            date: datePart,
            time: timePart,
            dayOfWeek,
            hour
          }
        });
      }
    }
    
    const oauth2Client = await createJustinOAuth2Client();
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Handle different actions
    let result;
    
    switch (action) {
      case 'create':
        // Parse the date for calendar - assuming startDateTime is in PT
        const startTime = new Date(startDateTime);
        const endTime = new Date(startTime.getTime() + (serviceDuration * 60000));
        
        const eventDetails = {
          summary: `${serviceType}: ${clientName}`,
          description: `Client: ${clientName}\nPhone: ${clientPhone}\nLocation: 1213 Alvarado Ave #84, Davis CA 95616`,
          location: '1213 Alvarado Ave #84, Davis CA 95616',
          start: { 
            dateTime: startTime.toISOString(),
            timeZone: 'America/Los_Angeles' // Explicitly set Pacific Time
          },
          end: { 
            dateTime: endTime.toISOString(),
            timeZone: 'America/Los_Angeles' // Explicitly set Pacific Time
          }
        };
        
        const event = await calendar.events.insert({ 
          calendarId: 'primary', 
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
          barber_id: preferredBarberId || process.env.JUSTIN_BARBER_ID
        });
        
        result = { 
          success: true, 
          action: 'create',
          eventId: event.data.id,
          eventLink: event.data.htmlLink,
          appointment: {
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString()
          }
        };
        break;
        
      case 'reschedule':
        if (!eventId || !newStartDateTime) {
          return res.status(400).json({
            success: false,
            error: 'Event ID and new start date-time are required for rescheduling'
          });
        }
        
        // Get existing event
        const existingEvent = await calendar.events.get({
          calendarId: 'primary',
          eventId
        });
        
        if (!existingEvent.data) {
          return res.status(404).json({
            success: false,
            error: 'Appointment not found in calendar'
          });
        }
        
        // Calculate new times
        const newStartTime = new Date(newStartDateTime);
        const newEndTime = new Date(newStartTime.getTime() + (serviceDuration * 60000));
        
        // Update the event in Google Calendar
        const updatedEvent = await calendar.events.update({
          calendarId: 'primary',
          eventId,
          resource: {
            ...existingEvent.data,
            summary: serviceType ? `${serviceType}: ${clientName}` : existingEvent.data.summary,
            start: { 
              dateTime: newStartTime.toISOString(),
              timeZone: 'America/Los_Angeles'
            },
            end: { 
              dateTime: newEndTime.toISOString(),
              timeZone: 'America/Los_Angeles'
            }
          },
          sendUpdates: 'all'
        });
        
        // Update in database
        await appointmentOps.updateByEventId(eventId, {
          start_time: newStartTime.toISOString(),
          end_time: newEndTime.toISOString(),
          service_type: serviceType || undefined
        });
        
        result = {
          success: true,
          action: 'reschedule',
          eventId: updatedEvent.data.id,
          eventLink: updatedEvent.data.htmlLink,
          message: 'Appointment successfully rescheduled'
        };
        break;
        
      case 'cancel':
        if (!eventId) {
          return res.status(400).json({
            success: false,
            error: 'Event ID is required for cancellation'
          });
        }
        
        // Delete from Google Calendar
        await calendar.events.delete({
          calendarId: 'primary',
          eventId,
          sendUpdates: 'all'
        });
        
        // Delete from database
        await appointmentOps.cancelAppointment(eventId);
        
        result = {
          success: true,
          action: 'cancel',
          eventId,
          message: 'Appointment successfully cancelled'
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
  const { phone } = req.query;
  
  if (!phone) {
    return res.status(400).json({ success: false, error: 'Missing phone number' });
  }
  
  try {
    console.log('Looking up client with phone:', phone);
    
    // Get client info by phone number directly using supabase
    const { data: client, error } = await supabase
      .from('clients')
      .select(`*`)
      .eq('phone_number', phone)
      .single();
    
    // Log the query result for debugging
    console.log('Query result:', { client, error });
    
    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching client:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
    
    // Get latest appointment if any
    let latestAppointment = null;
    if (client) {
      const { data: appointments, error: apptError } = await supabase
        .from('appointments')
        .select('id, start_time, google_calendar_event_id, service_type')
        .eq('client_phone', phone)
        .order('start_time', { ascending: false })
        .limit(1);

      if (!apptError && appointments && appointments.length > 0) {
        latestAppointment = appointments[0];
      }
    }
    
    return res.status(200).json({
      success: true,
      found: !!client,
      client: client || null,
      barber: {
        id: process.env.JUSTIN_BARBER_ID || "0f1b62ea-f65c-487d-a3e3-3b268b67f584",
        name: "Justin",
        phone: "+19727541499"
      },
      latestAppointment
    });
  } catch (e) {
    console.error('Error in get-client:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
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