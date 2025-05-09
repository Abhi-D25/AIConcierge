// routes/webhook.js
const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { clientOps, serviceOps, locationOps, appointmentOps, portfolioOps, conversationOps, supabase } = require('../../../utils/supabase/clients/makeup-artist');
const { parseDateTime, formatToTimeZone } = require('../../../utils/timeZoneHandler');

// Helper function to create OAuth2 client
const createOAuth2Client = (refreshToken) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
};

// Helper function to parse date-time from various formats
function parseCentralDateTime(dateTimeString) {
    return parseDateTime(dateTimeString, 'makeup_artist');
}

// 1. CLIENT MANAGEMENT ENDPOINTS

// Get client information by phone number
router.get('/get-client-info', async (req, res) => {
  const clientPhone = req.query.phone;
  if (!clientPhone) return res.status(400).json({ success: false, error: 'Phone number required' });
  
  try {
    let formattedPhone = clientPhone;
    const digits = formattedPhone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('+')) formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;

    const client = await clientOps.getByPhoneNumber(formattedPhone);
    if (!client) return res.status(200).json({ success: true, found: false, message: 'Client not found' });

    // Get client's upcoming appointments
    let upcomingAppointment = null;
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('id, start_time, service_id, location_id, google_calendar_event_id, status, deposit_status')
      .eq('client_phone', formattedPhone)
      .gte('start_time', new Date().toISOString())
      .order('start_time', { ascending: true })
      .limit(1);

    if (appointments && appointments.length > 0) {
      upcomingAppointment = appointments[0];
      
      // Get service details if available
      if (upcomingAppointment.service_id) {
        const { data: service } = await supabase
          .from('services')
          .select('name, base_price, duration_minutes')
          .eq('id', upcomingAppointment.service_id)
          .single();
          
        if (service) {
          upcomingAppointment.service = service;
        }
      }
      
      // Get location details if available
      if (upcomingAppointment.location_id) {
        const { data: location } = await supabase
          .from('locations')
          .select('name, travel_fee')
          .eq('id', upcomingAppointment.location_id)
          .single();
          
        if (location) {
          upcomingAppointment.location = location;
        }
      }
    }

    return res.status(200).json({
      success: true,
      found: true,
      client: {
        id: client.id,
        name: client.name,
        phone: client.phone_number,
        email: client.email,
        skin_type: client.skin_type,
        skin_tone: client.skin_tone,
        allergies: client.allergies,
        preferred_service_type: client.preferred_service_type,
        special_notes: client.special_notes
      },
      upcomingAppointment
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Create or update client
router.post('/create-client', async (req, res) => {
  const { 
    phoneNumber, 
    name = "New Client", 
    email,
    skinType,
    skinTone,
    allergies,
    preferredServiceType,
    specialNotes
  } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    // Format phone number
    let formattedPhone = phoneNumber;
    const digits = formattedPhone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    }
    
    // Check if the client already exists
    const existingClient = await clientOps.getByPhoneNumber(formattedPhone);
    
    // Prepare client data
    const clientData = {
      phone_number: formattedPhone,
      name,
      email,
      skin_type: skinType,
      skin_tone: skinTone,
      allergies,
      preferred_service_type: preferredServiceType,
      special_notes: specialNotes
    };
    
    // Update or create client
    const client = await clientOps.createOrUpdate(clientData);
    
    return res.status(200).json({
      success: true,
      message: existingClient ? 'Client updated' : 'Client created',
      client,
      isNew: !existingClient
    });
  } catch (e) {
    console.error('Error in create-client:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Store client's skin preferences
router.post('/store-skin-preferences', async (req, res) => {
  const { 
    phoneNumber, 
    skinType,
    skinTone,
    allergies,
    specialNotes
  } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    // Format phone number
    let formattedPhone = phoneNumber;
    const digits = formattedPhone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    }
    
    // Get existing client
    const existingClient = await clientOps.getByPhoneNumber(formattedPhone);
    
    if (!existingClient) {
      return res.status(404).json({ 
        success: false, 
        error: 'Client not found' 
      });
    }
    
    // Update skin preferences
    const { data, error } = await supabase
      .from('clients')
      .update({
        skin_type: skinType || existingClient.skin_type,
        skin_tone: skinTone || existingClient.skin_tone,
        allergies: allergies || existingClient.allergies,
        special_notes: specialNotes || existingClient.special_notes,
        updated_at: new Date()
      })
      .eq('phone_number', formattedPhone)
      .select();
    
    if (error) {
      throw error;
    }
    
    return res.status(200).json({
      success: true,
      message: 'Skin preferences updated',
      client: data[0]
    });
  } catch (e) {
    console.error('Error in store-skin-preferences:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// 2. CALENDAR & APPOINTMENTS ENDPOINTS

// Create, reschedule, or cancel appointments
router.post('/client-appointment', async (req, res) => {
    let { 
      clientPhone, 
      clientName = "New Client", 
      serviceId, 
      locationId,
      specificAddress,
      startDateTime, 
      endDateTime,
      newStartDateTime, 
      duration = 60, 
      notes = '', 
      isCancelling = false, 
      isRescheduling = false, 
      eventId,
      depositAmount,
      totalAmount,
      paymentMethod,
      groupClients = []
    } = req.body;
    
    // Parse boolean strings to actual booleans
    if (typeof isCancelling === 'string') isCancelling = isCancelling.toLowerCase() === 'true';
    if (typeof isRescheduling === 'string') isRescheduling = isRescheduling.toLowerCase() === 'true';
    if (typeof duration === 'string') duration = parseInt(duration, 10) || 60;
    
    // Validate required fields
    if (!clientPhone) {
      return res.status(400).json({ success: false, error: 'Client phone number is required' });
    }
    
    try {
      // Get or create client
      let client = await clientOps.getByPhoneNumber(clientPhone);
      
      if (!client && !isCancelling) {
        client = await clientOps.createOrUpdate({ 
          phone_number: clientPhone, 
          name: clientName
        });
      }
      
      // Get artist's Google Calendar credentials (assuming makeup artist has a record in the database)
      const { data: artist, error: artistError } = await supabase
        .from('makeup_artists')
        .select('*')
        .single();
      
      if (artistError || !artist?.refresh_token) {
        return res.status(404).json({ 
          success: false, 
          error: 'Makeup artist not found or not authorized' 
        });
      }
      
      // Create Google Calendar client
      const oauth2Client = createOAuth2Client(artist.refresh_token);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      const calendarId = artist.selected_calendar_id || 'primary';
      
      // Handle different operations based on request type
      if (isCancelling) {
        // Cancel appointment logic
        if (!eventId) {
          return res.status(400).json({ success: false, error: 'Event ID is required for cancellation' });
        }
        
        // Delete from Google Calendar
        await calendar.events.delete({
          calendarId,
          eventId,
          sendUpdates: 'all'
        });
        
        // Update appointment status in database
        const { data, error } = await supabase
          .from('appointments')
          .update({ status: 'canceled', updated_at: new Date() })
          .eq('google_calendar_event_id', eventId)
          .select();
        
        return res.status(200).json({
          success: true,
          action: 'cancel',
          eventId,
          message: 'Appointment successfully cancelled'
        });
      } else if (isRescheduling) {
        // Reschedule appointment logic
        if (!eventId || !newStartDateTime) {
          return res.status(400).json({ 
            success: false, 
            error: 'Event ID and new start date-time are required for rescheduling' 
          });
        }
        
        // Get existing event
        const existingEvent = await calendar.events.get({
          calendarId,
          eventId
        });
        
        if (!existingEvent.data) {
          return res.status(404).json({
            success: false,
            error: 'Appointment not found in calendar'
          });
        }
        
        // Parse new start time for Central Time and calculate new end time
        const newStartTime = parseCentralDateTime(newStartDateTime);
        const newEndTime = new Date(newStartTime.getTime() + (duration * 60000));
        
        // Update the event in Google Calendar
        const updatedEvent = await calendar.events.update({
          calendarId,
          eventId,
          resource: {
            ...existingEvent.data,
            summary: `Makeup: ${clientName}`,
            start: formatToTimeZone(newStartTime, 'makeup_artist'),
            end: formatToTimeZone(newEndTime, 'makeup_artist')
          },
          sendUpdates: 'all'
        });
        
        // Update the appointment in the database
        const { data, error } = await supabase
          .from('appointments')
          .update({
            start_time: newStartTime.toISOString(),
            end_time: newEndTime.toISOString(),
            updated_at: new Date()
          })
          .eq('google_calendar_event_id', eventId)
          .select();
        
        return res.status(200).json({
          success: true,
          action: 'reschedule',
          eventId: updatedEvent.data.id,
          eventLink: updatedEvent.data.htmlLink,
          message: 'Appointment successfully rescheduled'
        });
      } else {
        // Create new appointment logic
        if (!startDateTime || !serviceId || !locationId) {
          return res.status(400).json({ 
            success: false, 
            error: 'Start date-time, service ID, and location ID are required for new appointments' 
          });
        }
        
        // Get service details
        const { data: service } = await supabase
          .from('services')
          .select('*')
          .eq('id', serviceId)
          .single();
        
        if (!service) {
          return res.status(404).json({
            success: false,
            error: 'Service not found'
          });
        }
        
        // Get location details
        const { data: location } = await supabase
          .from('locations')
          .select('*')
          .eq('id', locationId)
          .single();
        
        if (!location) {
          return res.status(404).json({
            success: false,
            error: 'Location not found'
          });
        }
        
        // Calculate time based on service duration - using Central Time
        const startTime = parseCentralDateTime(startDateTime);
        const endTime = new Date(startTime.getTime() + (service.duration_minutes * 60000));
        
        // Create event description with all details
        let description = `Client: ${clientName}\nPhone: ${clientPhone}\n`;
        description += `Service: ${service.name}\n`;
        description += `Location: ${location.name}`;
        
        if (specificAddress) {
          description += ` (${specificAddress})`;
        }
        
        description += `\nTravel Fee: $${location.travel_fee}`;
        
        if (notes) {
          description += `\n\nNotes: ${notes}`;
        }
        
        // Add group clients to description if any
        if (groupClients && groupClients.length > 0) {
          description += '\n\nAdditional clients:';
          groupClients.forEach(gc => {
            description += `\n- ${gc.name} (${gc.service || 'No service specified'})`;
          });
        }
        
        // Create Google Calendar event - using Central Time
        const eventDetails = {
          summary: `Makeup: ${clientName}`,
          description,
          location: specificAddress || location.name,
          start: formatToTimeZone(startTime, 'makeup_artist'),
          end: formatToTimeZone(endTime, 'makeup_artist')
        };
        
        const event = await calendar.events.insert({ 
          calendarId, 
          resource: eventDetails,
          sendUpdates: 'all'
        });
        
        // Create appointment record in database
        const appointmentData = {
          client_phone: clientPhone,
          service_id: serviceId,
          location_id: locationId,
          specific_address: specificAddress,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          google_calendar_event_id: event.data.id,
          status: 'confirmed',
          deposit_amount: depositAmount,
          deposit_status: depositAmount > 0 ? 'paid' : 'pending',
          total_amount: totalAmount || service.base_price + location.travel_fee,
          payment_status: 'pending',
          payment_method: paymentMethod,
          notes
        };
        
        const { data: appointment, error: apptError } = await supabase
          .from('appointments')
          .insert(appointmentData)
          .select();
        
        if (apptError) {
          console.error('Error creating appointment record:', apptError);
        }
        
        // Create group booking records if any
        if (appointment && groupClients && groupClients.length > 0) {
          const groupBookingsData = groupClients.map(gc => ({
            main_appointment_id: appointment[0].id,
            client_phone: gc.phone,
            client_name: gc.name,
            service_id: gc.serviceId,
            price: gc.price,
            notes: gc.notes
          }));
          
          const { data: groupBookings, error: gbError } = await supabase
            .from('group_bookings')
            .insert(groupBookingsData);
          
          if (gbError) {
            console.error('Error creating group bookings:', gbError);
          }
        }
        
        return res.status(200).json({
          success: true,
          action: 'create',
          eventId: event.data.id,
          eventLink: event.data.htmlLink,
          appointment: appointment ? appointment[0] : null,
          message: 'Appointment successfully created'
        });
      }
    } catch (e) {
      console.error('Error in client-appointment endpoint:', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

// Check availability for a specific date and time
router.post('/check-availability', async (req, res) => {
    const { startDateTime, endDateTime, serviceDuration = 60 } = req.body;
    
    if (!startDateTime) {
      return res.status(400).json({ 
        success: false, 
        error: 'Start date-time is required' 
      });
    }
    
    try {
      // Get makeup artist's calendar credentials
      const { data: artist, error: artistError } = await supabase
        .from('makeup_artists')
        .select('*')
        .single();
      
      if (artistError || !artist?.refresh_token) {
        return res.status(404).json({ 
          success: false, 
          error: 'Makeup artist not found or not authorized' 
        });
      }
      
      const oauth2Client = createOAuth2Client(artist.refresh_token);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      const calendarId = artist.selected_calendar_id || 'primary';
      
      // Parse specific start time from request - using Central Time
      const requestedStart = parseCentralDateTime(startDateTime);
      
      // Calculate the end time based on service duration
      const requestedEnd = endDateTime 
        ? parseCentralDateTime(endDateTime)
        : new Date(requestedStart.getTime() + (serviceDuration * 60000));
      
      // Use a wider time window to fetch all potentially conflicting events
      const timeMin = new Date(requestedStart.getTime() - (60 * 60000)); // 1 hour before
      const timeMax = new Date(requestedEnd.getTime() + (60 * 60000));   // 1 hour after
      
      const response = await calendar.events.list({
        calendarId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: 'America/Chicago', // Central Time
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 100
      });
      
      // Check if any existing events overlap with the requested time slot
      const isAvailable = !response.data.items.some(event => {
        const eventStart = new Date(event.start.dateTime || event.start.date);
        const eventEnd = new Date(event.end.dateTime || event.end.date);
        
        // Check for overlap
        return (
          (requestedStart < eventEnd && requestedEnd > eventStart) ||
          (eventStart < requestedEnd && eventEnd > requestedStart)
        );
      });
      
      // Set the correct content type
      res.setHeader('Content-Type', 'application/json');
      
      // Send a clean response
      const result = {
        success: true,
        isAvailable: isAvailable,
        requestedTimeSlot: {
          start: requestedStart.toISOString(),
          end: requestedEnd.toISOString(),
          duration: serviceDuration
        },
        conflictingEvents: isAvailable ? [] : response.data.items.map(event => ({
          id: event.id,
          summary: event.summary || "Untitled",
          start: event.start?.dateTime || event.start?.date,
          end: event.end?.dateTime || event.end?.date
        }))
      };
      
      return res.send(JSON.stringify(result));
    } catch (e) {
      console.error('Error in check-availability:', e);
      res.setHeader('Content-Type', 'application/json');
      return res.send(JSON.stringify({ success: false, error: e.message }));
    }
  });

// Find next available slots
router.post('/find-available-slots', async (req, res) => {
    const { 
      currentTimestamp, 
      numSlots = 3, 
      slotDurationMinutes = 60,
      serviceId
    } = req.body;
    
    if (!currentTimestamp) {
      return res.status(400).json({ 
        success: false, 
        error: 'Current timestamp is required' 
      });
    }
    
    try {
      // Get service duration if service ID is provided
      let duration = slotDurationMinutes;
      
      if (serviceId) {
        const { data: service } = await supabase
          .from('services')
          .select('duration_minutes')
          .eq('id', serviceId)
          .single();
        
        if (service) {
          duration = service.duration_minutes;
        }
      }
      
      // Get makeup artist's calendar credentials
      const { data: artist, error: artistError } = await supabase
        .from('makeup_artists')
        .select('*')
        .single();
      
      if (artistError || !artist?.refresh_token) {
        return res.status(404).json({ 
          success: false, 
          error: 'Makeup artist not found or not authorized' 
        });
      }
      
      const oauth2Client = createOAuth2Client(artist.refresh_token);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      const calendarId = artist.selected_calendar_id || 'primary';
      
      // Helper function to find available slots - using Central Time
      async function findNextAvailableSlots(startFrom, numSlots, slotMinutes) {
        const results = [];
        let searchTime = parseCentralDateTime(startFrom);
        const endTime = new Date(searchTime);
        endTime.setDate(endTime.getDate() + 14); // Look 2 weeks ahead
        
        // Get business hours (9am-6pm Central Time)
        const businessHoursStart = 9; // 9am
        const businessHoursEnd = 18; // 6pm
        
        // Get all existing appointments in the search period
        const busyEvents = await calendar.events.list({
          calendarId,
          timeMin: searchTime.toISOString(),
          timeMax: endTime.toISOString(),
          timeZone: 'America/Chicago', // Using Central Time
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250
        });
        
        const busy = busyEvents.data.items.map(evt => ({
          start: new Date(evt.start.dateTime || evt.start.date),
          end: new Date(evt.end.dateTime || evt.end.date)
        }));
        
        // Find available slots
        while (results.length < numSlots && searchTime < endTime) {
          // Skip to business hours
          const hours = searchTime.getHours();
          const minutes = searchTime.getMinutes();
          
          // If before business hours, skip to start of business hours
          if (hours < businessHoursStart) {
            searchTime.setHours(businessHoursStart, 0, 0, 0);
          }
          
          // If after business hours, skip to start of next day's business hours
          if (hours >= businessHoursEnd) {
            searchTime.setDate(searchTime.getDate() + 1);
            searchTime.setHours(businessHoursStart, 0, 0, 0);
            continue;
          }
          
          // Check if candidate slot fits within business hours
          const candidateEnd = new Date(searchTime.getTime() + slotMinutes * 60000);
          if (candidateEnd.getHours() >= businessHoursEnd) {
            // Skip to next day
            searchTime.setDate(searchTime.getDate() + 1);
            searchTime.setHours(businessHoursStart, 0, 0, 0);
            continue;
          }
          
          // Check if candidate slot overlaps with any busy times
          const overlaps = busy.some(evt => 
            (searchTime < evt.end && candidateEnd > evt.start)
          );
          
          if (!overlaps) {
            results.push({ 
              start: new Date(searchTime), 
              end: new Date(candidateEnd) 
            });
            
            // Move to next slot
            searchTime = new Date(candidateEnd);
          } else {
            // Move to next 30-minute boundary
            const nextMinutes = (Math.floor(minutes / 30) + 1) * 30;
            if (nextMinutes >= 60) {
              searchTime.setHours(hours + 1, 0, 0, 0);
            } else {
              searchTime.setHours(hours, nextMinutes, 0, 0);
            }
          }
        }
        
        return results.map(slot => ({
          start: slot.start.toISOString(),
          end: slot.end.toISOString(),
          duration: slotMinutes
        }));
      }
      
      // Find available slots
      const slots = await findNextAvailableSlots(
        currentTimestamp,
        numSlots,
        duration
      );
      
      return res.status(200).json({
        success: true,
        slotsFound: slots.length,
        slots,
        duration,
        timeZone: 'America/Chicago' // Indicate Central Time
      });
    } catch (e) {
      console.error('Error in find-available-slots:', e);
      return res.status(500).json({ 
        success: false, 
        error: e.message 
      });
    }
  });

// Get pending appointments
router.get('/get-pending-appointments', async (req, res) => {
  const { clientPhone, includeCompleted = false } = req.query;
  
  try {
    let query = supabase
      .from('appointments')
      .select(`
        *,
        client:clients(name, phone_number),
        service:services(name, base_price, duration_minutes),
        location:locations(name, travel_fee)
      `)
      .order('start_time', { ascending: true });
    
    // Filter by client phone if provided
    if (clientPhone) {
      query = query.eq('client_phone', clientPhone);
    }
    
    // Filter by status
    if (includeCompleted === 'true' || includeCompleted === true) {
      query = query.in('status', ['pending', 'confirmed', 'completed']);
    } else {
      query = query.in('status', ['pending', 'confirmed']);
    }
    
    // Only get future appointments
    query = query.gte('start_time', new Date().toISOString());
    
    const { data, error } = await query;
    
    if (error) {
      throw error;
    }
    
    // For each appointment, get group bookings if any
    for (const appointment of data) {
      const { data: groupBookings, error: gbError } = await supabase
        .from('group_bookings')
        .select('*')
        .eq('main_appointment_id', appointment.id);
      
      if (!gbError && groupBookings?.length > 0) {
        appointment.group_bookings = groupBookings;
      }
    }
    
    return res.status(200).json({
      success: true,
      appointments: data,
      count: data.length
    });
  } catch (e) {
    console.error('Error in get-pending-appointments:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Update appointment status
router.post('/update-appointment-status', async (req, res) => {
  const { appointmentId, status, paymentStatus, paymentMethod, paymentAmount } = req.body;
  
  if (!appointmentId || !status) {
    return res.status(400).json({ 
      success: false, 
      error: 'Appointment ID and status are required' 
    });
  }
  
  try {
    // Prepare update data
    const updateData = { status, updated_at: new Date() };
    
    // Add payment info if provided
    if (paymentStatus) updateData.payment_status = paymentStatus;
    if (paymentMethod) updateData.payment_method = paymentMethod;
    if (paymentAmount) updateData.payment_amount = paymentAmount;
    
    // Update appointment
    const { data, error } = await supabase
      .from('appointments')
      .update(updateData)
      .eq('id', appointmentId)
      .select();
    
    if (error) {
      throw error;
    }
    
    return res.status(200).json({
      success: true,
      message: 'Appointment status updated',
      appointment: data[0]
    });
  } catch (e) {
    console.error('Error in update-appointment-status:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// 3. CONVERSATION MANAGEMENT ENDPOINTS 

// Store a message in the conversation
router.post('/conversation/store-message', async (req, res) => {
  const { phoneNumber, role, content, metadata } = req.body;
  
  if (!phoneNumber || !role || !content) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: phoneNumber, role, content' 
    });
  }
  
  try {
    // Get or create session
    const session = await conversationOps.getOrCreateSession(phoneNumber);
    if (!session) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to get or create session' 
      });
    }
    
    // Add message
    const message = await conversationOps.addMessage(
      session.id, 
      role, 
      content, 
      metadata
    );
    
    if (!message) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to store message' 
      });
    }
    
    return res.status(200).json({
      success: true,
      message,
      sessionId: session.id
    });
  } catch (e) {
    console.error('Error in store-message:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Get conversation history
router.get('/conversation/history', async (req, res) => {
  const { phoneNumber, limit = 10 } = req.query;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    const history = await conversationOps.getConversationHistory(
      phoneNumber, 
      parseInt(limit)
    );
    
    return res.status(200).json({
      success: true,
      history,
      count: history.length
    });
  } catch (e) {
    console.error('Error in get-history:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Process and consolidate messages
router.post('/conversation/process-message', async (req, res) => {
  const { 
    phoneNumber, 
    content, 
    role = 'user', 
    timeWindowMs = 5000,  // 5 second window by default
    metadata = null
  } = req.body;
  
  if (!phoneNumber || !content) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number and content are required' 
    });
  }
  
  try {
    const session = await conversationOps.getOrCreateSession(phoneNumber);
    if (!session) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to get or create session' 
      });
    }
    
    // Store the current message
    const message = await conversationOps.addMessage(
      session.id, 
      role, 
      content, 
      metadata
    );
    
    // Wait for the time window to check for additional messages
    await new Promise(resolve => setTimeout(resolve, timeWindowMs));
    
    // Get all messages within the time window
    // NOTE: We need to account for the fact that we already waited for timeWindowMs
    const cutoffTime = new Date(Date.now() - (timeWindowMs * 2));
    const { data: recentMessages, error } = await supabase
      .from('conversation_messages')
      .select('*')
      .eq('session_id', session.id)
      .eq('role', 'user')
      .gte('created_at', cutoffTime.toISOString())
      .order('created_at', { ascending: true });
    
    if (error) {
      console.error('Error fetching messages:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch recent messages',
        details: error.message
      });
    }
    
    // Check if newer messages exist
    const thisMessageId = message.id;
    const hasNewerMessages = recentMessages.some(msg => 
      msg.id !== thisMessageId && new Date(msg.created_at) > new Date(message.created_at)
    );
    
    if (hasNewerMessages) {
      // Not the final message
      return res.status(200).json({
        success: true,
        isFinalMessage: false,
        content: content,
        sessionId: session.id
      });
    }
    
    // Aggregate all messages including current
    const aggregatedContent = recentMessages
      .map(msg => msg.content)
      .join(' ');
    
    // Mark all messages as processed (if metadata exists)
    if (recentMessages.length > 0) {
      const messageIds = recentMessages.map(msg => msg.id);
      await supabase
        .from('conversation_messages')
        .update({ metadata: { processed: true } })
        .in('id', messageIds);
    }
    
    return res.status(200).json({
      success: true,
      isFinalMessage: true,
      content: aggregatedContent || content,
      sessionId: session.id,
      messageCount: recentMessages.length
    });
  } catch (e) {
    console.error('Error in process-message:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Store temporary messages
router.post('/store-temp-messages', async (req, res) => {
  const { phoneNumber, role = "user", messages, content } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    // Get or create session
    const session = await conversationOps.getOrCreateSession(phoneNumber);
    if (!session) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to get or create session' 
      });
    }
    
    // Get the most recent message with temp_messages
    const { data: existingData, error: fetchError } = await supabase
      .from('conversation_messages')
      .select('*')
      .eq('session_id', session.id)
      .filter('metadata->is_temp', 'eq', true)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (fetchError) {
      console.error('Error fetching existing temp messages:', fetchError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch existing temp messages',
        details: fetchError.message
      });
    }
    
    // Initialize conversation array
    let conversation = [];
    
    // If we have existing data, use it as the base
    if (existingData && existingData.length > 0 && existingData[0].temp_messages) {
      if (Array.isArray(existingData[0].temp_messages)) {
        conversation = existingData[0].temp_messages;
      } else {
        // If it's not an array, initialize with a single entry
        conversation = [{ role: "system", content: "Conversation initialized" }];
      }
    } else {
      // Start a new conversation
      conversation = [{ role: "system", content: "Conversation initialized" }];
    }
    
    // Add the new message to the conversation
    if (content || messages) {
      // If it's a direct content string, add it as a message
      if (content) {
        conversation.push({
          role: role,
          content: content
        });
      } 
      // If it's a messages object, add it
      else if (messages) {
        if (typeof messages === 'string') {
          conversation.push({
            role: role,
            content: messages
          });
        } else {
          // If it's already an object or array, try to handle it intelligently
          if (Array.isArray(messages)) {
            // If it's an array, append all messages
            conversation = [...conversation, ...messages];
          } else if (messages.content) {
            // If it has content, treat as a single message
            conversation.push({
              role: messages.role || role,
              content: messages.content
            });
          } else {
            // Fallback: just stringify and store
            conversation.push({
              role: role,
              content: JSON.stringify(messages)
            });
          }
        }
      }
    }
    
    // Store the updated conversation
    const { data, error } = await supabase
      .from('conversation_messages')
      .upsert({ 
        session_id: session.id,
        role: 'system', // This is a system message to store the temp conversation
        content: 'Temporary conversation storage',
        temp_messages: conversation,
        metadata: { is_temp: true },
        created_at: new Date().toISOString() // Use current timestamp
      });
    
    if (error) {
      console.error('Error storing temp messages:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to store temporary messages',
        details: error.message
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Temporary messages stored successfully',
      sessionId: session.id,
      conversationLength: conversation.length
    });
  } catch (e) {
    console.error('Error in store-temp-messages:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Check temporary messages
router.get('/check-temp-messages', async (req, res) => {
  const { phoneNumber } = req.query;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    // Get the session
    const session = await conversationOps.getOrCreateSession(phoneNumber);
    if (!session) {
      return res.status(404).json({ 
        success: false, 
        error: 'Session not found' 
      });
    }
    
    // Get the most recent message with temp_messages
    const { data, error } = await supabase
      .from('conversation_messages')
      .select('*')
      .eq('session_id', session.id)
      .filter('metadata->is_temp', 'eq', true)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error checking temp messages:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to check temporary messages',
        details: error.message
      });
    }
    
    // Format the conversation for easy reading
    let formattedConversation = '';
    let rawConversation = [];
    
    if (data && data.length > 0 && data[0].temp_messages) {
      rawConversation = data[0].temp_messages;
      
      // Skip the first system message in formatting
      for (let i = 1; i < rawConversation.length; i++) {
        const msg = rawConversation[i];
        if (msg.role && msg.content) {
          // Add a formatted line to the conversation
          formattedConversation += `${msg.role.toUpperCase()}: ${msg.content}\n\n`;
        }
      }
    }
    
    return res.status(200).json({
      success: true,
      conversation: formattedConversation.trim(),
      rawConversation: rawConversation,
      hasMessages: rawConversation.length > 1 // More than just the system message
    });
  } catch (e) {
    console.error('Error in check-temp-messages:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Clear temporary messages
router.post('/clear-temp-messages', async (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    // Get the session
    const session = await conversationOps.getOrCreateSession(phoneNumber);
    if (!session) {
      return res.status(404).json({ 
        success: false, 
        error: 'Session not found' 
      });
    }
    
    // Clear temp messages
    const { data, error } = await supabase
      .from('conversation_messages')
      .update({ 
        temp_messages: null,
        metadata: { is_temp: false }
      })
      .eq('session_id', session.id)
      .filter('metadata->is_temp', 'eq', true);
    
    if (error) {
      console.error('Error clearing temp messages:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to clear temporary messages',
        details: error.message
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Temporary messages cleared successfully'
    });
  } catch (e) {
    console.error('Error in clear-temp-messages:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// 4. PAYMENTS & DEPOSITS ENDPOINTS

// Create payment link
router.post('/create-payment-link', async (req, res) => {
  const { appointmentId, amount, description } = req.body;
  
  if (!appointmentId || !amount) {
    return res.status(400).json({ 
      success: false, 
      error: 'Appointment ID and amount are required' 
    });
  }
  
  try {
    // For simplicity, we're just returning a mock payment link
    // In a real implementation, you'd integrate with a payment provider like Stripe
    
    const paymentLink = `https://example.com/pay/${appointmentId}?amount=${amount}`;
    
    // Update appointment with pending payment info
    const { data, error } = await supabase
      .from('appointments')
      .update({
        deposit_amount: amount,
        deposit_status: 'pending',
        payment_link: paymentLink,
        updated_at: new Date()
      })
      .eq('id', appointmentId)
      .select();
    
    if (error) {
      throw error;
    }
    
    return res.status(200).json({
      success: true,
      paymentLink,
      message: 'Payment link created',
      appointment: data[0]
    });
  } catch (e) {
    console.error('Error in create-payment-link:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Check payment status
router.get('/check-payment-status', async (req, res) => {
  const { appointmentId } = req.query;
  
  if (!appointmentId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Appointment ID is required' 
    });
  }
  
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('id, deposit_amount, deposit_status, payment_status, total_amount')
      .eq('id', appointmentId)
      .single();
    
    if (error) {
      throw error;
    }
    
    return res.status(200).json({
      success: true,
      appointment: data,
      depositStatus: data.deposit_status,
      paymentStatus: data.payment_status
    });
  } catch (e) {
    console.error('Error in check-payment-status:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Update payment status
router.post('/update-payment-status', async (req, res) => {
  const { appointmentId, depositStatus, paymentStatus, paymentMethod } = req.body;
  
  if (!appointmentId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Appointment ID is required' 
    });
  }
  
  try {
    // Prepare update data
    const updateData = { updated_at: new Date() };
    
    if (depositStatus) updateData.deposit_status = depositStatus;
    if (paymentStatus) updateData.payment_status = paymentStatus;
    if (paymentMethod) updateData.payment_method = paymentMethod;
    
    // Update appointment
    const { data, error } = await supabase
      .from('appointments')
      .update(updateData)
      .eq('id', appointmentId)
      .select();
    
    if (error) {
      throw error;
    }
    
    return res.status(200).json({
      success: true,
      message: 'Payment status updated',
      appointment: data[0]
    });
  } catch (e) {
    console.error('Error in update-payment-status:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// 5. PORTFOLIO & SERVICES ENDPOINTS

// Get services
router.get('/get-services', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('services')
      .select('*')
      .order('base_price', { ascending: true });
    
    if (error) {
      throw error;
    }
    
    return res.status(200).json({
      success: true,
      services: data,
      count: data.length
    });
  } catch (e) {
    console.error('Error in get-services:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Get portfolio examples
router.get('/get-portfolio-examples', async (req, res) => {
  const { serviceId, skinTone, limit = 5 } = req.query;
  
  try {
    let query = supabase
      .from('portfolio')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (serviceId) {
      query = query.eq('service_id', serviceId);
    }
    
    if (skinTone) {
      query = query.ilike('skin_tone', `%${skinTone}%`);
    }
    
    const { data, error } = await query.limit(parseInt(limit));
    
    if (error) {
      throw error;
    }
    
    // Get service details for each portfolio item
    for (const item of data) {
      if (item.service_id) {
        const { data: service } = await supabase
          .from('services')
          .select('name')
          .eq('id', item.service_id)
          .single();
        
        if (service) {
          item.service_name = service.name;
        }
      }
    }
    
    return res.status(200).json({
      success: true,
      portfolioItems: data,
      count: data.length
    });
  } catch (e) {
    console.error('Error in get-portfolio-examples:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Get location fees
router.get('/get-location-fees', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .order('travel_fee', { ascending: true });
    
    if (error) {
      throw error;
    }
    
    return res.status(200).json({
      success: true,
      locations: data,
      count: data.length
    });
  } catch (e) {
    console.error('Error in get-location-fees:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// 6. BOOKING PROCESS ENDPOINTS

// Create booking form
router.post('/create-booking-form', async (req, res) => {
  const { clientPhone, appointmentId } = req.body;
  
  if (!clientPhone) {
    return res.status(400).json({ 
      success: false, 
      error: 'Client phone is required' 
    });
  }
  
  try {
    // For simplicity, we're just returning a mock form link
    // In a real implementation, you'd generate a custom form link with prefilled data
    
    const formLink = appointmentId 
      ? `https://example.com/booking-form?client=${clientPhone}&appointment=${appointmentId}`
      : `https://example.com/booking-form?client=${clientPhone}`;
    
    return res.status(200).json({
      success: true,
      formLink,
      message: 'Booking form link created'
    });
  } catch (e) {
    console.error('Error in create-booking-form:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Check form submission
router.get('/check-form-submission', async (req, res) => {
  const { clientPhone, appointmentId } = req.query;
  
  if (!clientPhone && !appointmentId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Client phone or appointment ID is required' 
    });
  }
  
  try {
    // For simplicity, we're just returning a mock response
    // In a real implementation, you'd check if the form has been submitted
    
    const isSubmitted = Math.random() > 0.5; // Random true/false for demo purposes
    
    return res.status(200).json({
      success: true,
      isSubmitted,
      submissionDate: isSubmitted ? new Date().toISOString() : null,
      message: isSubmitted ? 'Form has been submitted' : 'Form has not been submitted yet'
    });
  } catch (e) {
    console.error('Error in check-form-submission:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Lookup endpoints for services and locations

// Lookup service ID by name
router.get('/lookup-service-id', async (req, res) => {
  const { serviceName } = req.query;
  
  if (!serviceName) {
    return res.status(400).json({ 
      success: false, 
      error: 'Service name is required' 
    });
  }
  
  try {
    // Search for service with similar name (case insensitive)
    const { data, error } = await supabase
      .from('services')
      .select('id, name, base_price, duration_minutes')
      .ilike('name', `%${serviceName}%`)
      .order('base_price', { ascending: true })
      .limit(1);
    
    if (error) {
      throw error;
    }
    
    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No service found with that name',
        serviceName
      });
    }
    
    return res.status(200).json({
      success: true,
      service: data[0],
      serviceId: data[0].id,
      serviceName: data[0].name,
      servicePrice: data[0].base_price,
      serviceDuration: data[0].duration_minutes
    });
  } catch (e) {
    console.error('Error in lookup-service-id:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Lookup location ID by name
router.get('/lookup-location-id', async (req, res) => {
  const { locationName } = req.query;
  
  if (!locationName) {
    return res.status(400).json({ 
      success: false, 
      error: 'Location name is required' 
    });
  }
  
  try {
    // Search for location with similar name (case insensitive)
    const { data, error } = await supabase
      .from('locations')
      .select('id, name, travel_fee, travel_time_minutes')
      .ilike('name', `%${locationName}%`)
      .order('travel_fee', { ascending: true })
      .limit(1);
    
    if (error) {
      throw error;
    }
    
    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No location found with that name',
        locationName
      });
    }
    
    return res.status(200).json({
      success: true,
      location: data[0],
      locationId: data[0].id,
      locationName: data[0].name,
      travelFee: data[0].travel_fee,
      travelTime: data[0].travel_time_minutes
    });
  } catch (e) {
    console.error('Error in lookup-location-id:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

router.post('/test-create-client', async (req, res) => {
    const { phoneNumber, name = "Test Client" } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ 
        success: false, 
        error: 'Phone number is required' 
      });
    }
    
    try {
      // Format phone number
      let formattedPhone = phoneNumber;
      const digits = formattedPhone.replace(/\D/g, '');
      if (!formattedPhone.startsWith('+')) {
        formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
      }
      
      // Try direct insertion
      const { data, error } = await supabase
        .from('clients')
        .insert({
          phone_number: formattedPhone,
          name: name,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select();
      
      if (error) {
        console.error('Direct insert error:', error);
        return res.status(500).json({ 
          success: false, 
          error: error.message,
          details: "Database operation failed"
        });
      }
      
      return res.status(200).json({
        success: true,
        message: "Client created directly",
        client: data[0],
        isNew: true
      });
    } catch (e) {
      console.error('Error in test-create-client:', e);
      return res.status(500).json({ 
        success: false, 
        error: e.message 
      });
    }
  });

  router.post('/store-conversation', async (req, res) => {
    const { 
      phoneNumber, 
      role = 'assistant', 
      content,
      metadata = null
    } = req.body;
    
    if (!phoneNumber || !content) {
      return res.status(400).json({ 
        success: false, 
        error: 'Phone number and content are required' 
      });
    }
    
    try {
      console.log(`Storing conversation for ${phoneNumber} with role ${role}`);
      
      // Get or create session
      const session = await conversationOps.getOrCreateSession(phoneNumber);
      if (!session) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to get or create session' 
        });
      }
      
      // Store the message
      const message = await conversationOps.addMessage(
        session.id, 
        role, 
        content, 
        metadata
      );
      
      if (!message) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to store message' 
        });
      }
      
      // Get recent conversation history (last 10 messages)
      const history = await conversationOps.getConversationHistory(phoneNumber, 10);
      
      return res.status(200).json({
        success: true,
        message: 'Conversation stored successfully',
        messageId: message.id,
        sessionId: session.id,
        recentHistory: history
      });
    } catch (e) {
      console.error('Error in store-conversation:', e);
      return res.status(500).json({ 
        success: false, 
        error: e.message 
      });
    }
  });

module.exports = router;