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

router.get('/check-availability', async (req, res) => {
  const { startDateTime, serviceDuration = 30 } = req.query;
  
  if (!startDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'startDateTime is required' 
    });
  }
  
  try {
    const oauth2Client = await createJustinOAuth2Client();
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // First, extract components directly from the string to avoid time zone conversion issues
    // Format expected: YYYY-MM-DDThh:mm:ss-07:00
    const dateParts = startDateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!dateParts) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format. Expected format: YYYY-MM-DDThh:mm:ss-07:00'
      });
    }
    
    // Create a Date object - this will be in UTC internally
    const requestedTime = new Date(startDateTime);
    
    // Extract day of week (0-6, where 0 is Sunday) and hour (in PT) directly from the string
    const year = parseInt(dateParts[1], 10);
    const month = parseInt(dateParts[2], 10) - 1; // 0-based month
    const date = parseInt(dateParts[3], 10);
    const hour = parseInt(dateParts[4], 10); // Hour in PT since input is in PT
    
    // Calculate day of week from the parsed components
    const tempDate = new Date(year, month, date);
    const day = tempDate.getDay();
    
    console.log('Time validation:', {
      input: startDateTime,
      parsedDate: `${year}-${month+1}-${date}`,
      parsedHour: hour,
      day,
      dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]
    });
    
    // Validate business hours directly using the extracted components
    let isValidBusinessHour = false;
    if (day === 4) { // Thursday
      isValidBusinessHour = hour >= 18 && hour < 22; // 6 PM - 10 PM
    } else if (day === 5) { // Friday
      isValidBusinessHour = hour >= 14 && hour < 20; // 2 PM - 8 PM
    }
    
    if (!isValidBusinessHour) {
      return res.status(200).json({
        success: true,
        isAvailable: false,
        reason: "Outside business hours",
        businessHours: {
          thursday: "6:00 PM - 10:00 PM PT",
          friday: "2:00 PM - 8:00 PM PT"
        },
        debug: {
          requestedDay: day,
          requestedDayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day],
          requestedHour: hour,
          isFriday: day === 5,
          hourCheck: hour >= 14 && hour < 20
        }
      });
    }
    
    // Calculate end time
    const endTime = new Date(requestedTime.getTime() + (parseInt(serviceDuration) * 60000));
    
    // Check calendar for conflicts
    const events = await calendar.events.list({
      calendarId: 'primary',
      timeMin: requestedTime.toISOString(),
      timeMax: endTime.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    
    const isAvailable = events.data.items.length === 0;
    
    return res.status(200).json({
      success: true,
      isAvailable,
      requestedTime: {
        start: requestedTime.toISOString(),
        end: endTime.toISOString()
      },
      serviceDuration: parseInt(serviceDuration)
    });
  } catch (error) {
    console.error('Error checking availability:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Get barber's availability
router.get('/find-available-slots', async (req, res) => {
  const { numSlots = 3, serviceDuration = 30 } = req.query;
  
  try {
    const oauth2Client = await createJustinOAuth2Client();
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // When finding next available slots, we don't need startDateTime
    if (findNextAvailable === 'true' || findNextAvailable === true) {
      console.log('Finding next available slots with serviceDuration:', serviceDuration);
      
      // Calculate today and next 14 days for search range
      const today = new Date();
      const twoWeeksLater = new Date();
      twoWeeksLater.setDate(today.getDate() + 14);
      
      // Find the next Thursday and Friday in this range
      const slots = [];
      
      // Loop through the date range to find all Thursdays and Fridays
      const currentDate = new Date(today);
      while (currentDate <= twoWeeksLater) {
        const day = currentDate.getDay();
        
        // Check if Thursday or Friday
        if (day === 4 || day === 5) {
          // Create a time range for business hours on this day
          const businessHoursStart = new Date(currentDate);
          const businessHoursEnd = new Date(currentDate);
          
          if (day === 4) { // Thursday
            businessHoursStart.setHours(18, 0, 0, 0); // 6 PM
            businessHoursEnd.setHours(22, 0, 0, 0);   // 10 PM
          } else { // Friday
            businessHoursStart.setHours(14, 0, 0, 0); // 2 PM
            businessHoursEnd.setHours(20, 0, 0, 0);   // 8 PM
          }
          
          // Only check if the business hours haven't passed yet today
          if (today < businessHoursEnd) {
            // Make sure we start from current time if checking today
            if (today.toDateString() === currentDate.toDateString() && 
                today > businessHoursStart) {
              businessHoursStart.setHours(today.getHours(), today.getMinutes(), 0, 0);
            }
            
            // Find available slots on this day
            const daySlots = await findAvailableSlotsSimple(
              calendar,
              'primary',
              businessHoursStart,
              businessHoursEnd,
              parseInt(serviceDuration, 10)
            );
            
            // Add to our collection
            slots.push(...daySlots);
            
            // Break if we have enough slots
            if (slots.length >= parseInt(numSlots, 10)) {
              break;
            }
          }
        }
        
        // Move to next day
        currentDate.setDate(currentDate.getDate() + 1);
      }
      
      // Limit to requested number of slots
      const limitedSlots = slots.slice(0, parseInt(numSlots, 10));
      
      return res.status(200).json({
        success: true,
        slots: availableSlots,
        serviceDuration: parseInt(serviceDuration),
        location: "1213 Alvarado Ave #84, Davis CA 95616"
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'Must provide findNextAvailable=true to find next available slots'
      });
    }
  } catch (error) {
    console.error('Error getting Thursday slots:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Simplified function to find available slots
async function findAvailableSlotsSimple(calendar, calendarId, startTime, endTime, slotDuration) {
  // Get all events in the time range
  const events = await calendar.events.list({
    calendarId,
    timeMin: startTime.toISOString(),
    timeMax: endTime.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });
  
  const busySlots = events.data.items.map(event => ({
    start: new Date(event.start.dateTime || event.start.date),
    end: new Date(event.end.dateTime || event.end.date)
  }));
  
  // Find available slots
  const availableSlots = [];
  let currentSlotStart = new Date(startTime);
  
  while (currentSlotStart < endTime) {
    const currentSlotEnd = new Date(currentSlotStart.getTime() + (slotDuration * 60000));
    
    // If slot end is after business hours end, break
    if (currentSlotEnd > endTime) {
      break;
    }
    
    // Check if slot overlaps with any busy time
    const isAvailable = !busySlots.some(busy => 
      (currentSlotStart < busy.end && currentSlotEnd > busy.start)
    );
    
    if (isAvailable) {
      availableSlots.push({
        start: currentSlotStart.toISOString(),
        end: currentSlotEnd.toISOString()
      });
    }
    
    // Move to next potential slot
    currentSlotStart = new Date(currentSlotStart.getTime() + (30 * 60000)); // Check every 30 min
  }
  
  return availableSlots;
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