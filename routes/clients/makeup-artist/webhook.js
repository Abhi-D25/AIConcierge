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

// Helper function to convert Central Time to UTC for database storage
function convertCTtoUTC(centralTimeString) {
  // Create a date object and treat it as Central Time
  const dateCT = new Date(centralTimeString);
  
  // Get the timezone offset for Central Time (America/Chicago)
  // This is a simplified approach - in production you might want to use a library like luxon
  const centralOffset = -6; // CST is UTC-6, CDT is UTC-5
  const isDST = isDaylightSavingTime(dateCT);
  const actualOffset = isDST ? -5 : -6;
  
  // Adjust the time by the Central Time offset to get UTC
  const utcDate = new Date(dateCT.getTime() + (actualOffset * 60 * 60 * 1000));
  return utcDate.toISOString();
}

// Helper function to convert UTC to Central Time for display
function convertUTCtoCT(utcTimeString) {
  const dateUTC = new Date(utcTimeString);
  
  // Get the timezone offset for Central Time
  const centralOffset = -6; // CST is UTC-6, CDT is UTC-5
  const isDST = isDaylightSavingTime(dateUTC);
  const actualOffset = isDST ? -5 : -6;
  
  // Adjust the time by the Central Time offset
  const ctDate = new Date(dateUTC.getTime() - (actualOffset * 60 * 60 * 1000));
  
  // Format as YYYY-MM-DDTHH:MM:SS
  const year = ctDate.getFullYear();
  const month = String(ctDate.getMonth() + 1).padStart(2, '0');
  const day = String(ctDate.getDate()).padStart(2, '0');
  const hours = String(ctDate.getHours()).padStart(2, '0');
  const minutes = String(ctDate.getMinutes()).padStart(2, '0');
  const seconds = String(ctDate.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

// Helper function to determine if a date is in Daylight Saving Time for Central Time
function isDaylightSavingTime(date) {
  // Simplified DST calculation for Central Time
  // DST starts: Second Sunday in March
  // DST ends: First Sunday in November
  
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // getMonth() returns 0-11
  const day = date.getDate();
  
  if (month < 3 || month > 11) {
    return false; // Winter months
  }
  
  if (month > 3 && month < 11) {
    return true; // Summer months
  }
  
  // March: DST starts on second Sunday
  if (month === 3) {
    const firstDayOfMarch = new Date(year, 2, 1).getDay(); // 0 = Sunday
    const secondSunday = 14 - ((firstDayOfMarch + 6) % 7);
    return day >= secondSunday;
  }
  
  // November: DST ends on first Sunday
  if (month === 11) {
    const firstDayOfNovember = new Date(year, 10, 1).getDay(); // 0 = Sunday
    const firstSunday = 7 - ((firstDayOfNovember + 6) % 7);
    return day < firstSunday;
  }
  
  return false;
}

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
      .select('id, start_time, service_type, location_description, google_calendar_event_id, status, deposit_status, duration_minutes')
      .eq('client_phone', formattedPhone)
      .gte('start_time', new Date().toISOString())
      .order('start_time', { ascending: true })
      .limit(1);

    if (appointments && appointments.length > 0) {
      upcomingAppointment = appointments[0];
      
      // Convert UTC times from database back to Central Time for display
      if (upcomingAppointment.start_time) {
        upcomingAppointment.start_time_ct = convertUTCtoCT(upcomingAppointment.start_time);
      }
      
      // Format service info from the text field
      if (upcomingAppointment.service_type) {
        upcomingAppointment.service = {
          name: upcomingAppointment.service_type,
          base_price: null, // You don't have this in your schema
          duration_minutes: upcomingAppointment.duration_minutes || 60
        };
      }
      
      // Format location info from the text field
      if (upcomingAppointment.location_description) {
        upcomingAppointment.location = {
          name: upcomingAppointment.location_description,
          travel_fee: null // You don't have this in your schema
        };
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
        special_notes: client.special_notes,
        status: client.status || 'Lead',
        status_notes: client.status_notes
      },
      upcomingAppointment
    });
  } catch (e) {
    console.error('Error in get-client-info:', e);
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

function debugTimeHandling(timeStr, durationMinutes = 30) {
    console.log('\n===== TIME HANDLING DEBUG =====');
    console.log(`Input time: ${timeStr}`);
    
    // Test direct Date object creation
    const dateObj = new Date(timeStr);
    console.log('\nJavaScript Date Object:');
    console.log(`- String representation: ${dateObj.toString()}`);
    console.log(`- ISO string: ${dateObj.toISOString()}`);
    console.log(`- Hours (local): ${dateObj.getHours()}`);
    console.log(`- Minutes (local): ${dateObj.getMinutes()}`);
    console.log(`- Server timezone offset: ${-dateObj.getTimezoneOffset() / 60} hours`);
    
    // Test end time calculation
    const endObj = new Date(dateObj.getTime() + (durationMinutes * 60000));
    console.log('\nCalculated End Time:');
    console.log(`- String representation: ${endObj.toString()}`);
    console.log(`- ISO string: ${endObj.toISOString()}`);
    
    // Test Google Calendar format
    console.log('\nGoogle Calendar Format:');
    const gcalFormat = {
      start: {
        dateTime: timeStr,
        timeZone: 'America/Chicago'
      },
      end: {
        dateTime: endObj.toISOString().replace(/\.\d{3}Z$/, ''),
        timeZone: 'America/Chicago'
      }
    };
    console.log(JSON.stringify(gcalFormat, null, 2));
    
    // Calculate end time with our helper function
    const calculatedEnd = calculateEndTime(timeStr, durationMinutes);
    console.log('\nUsing calculateEndTime helper:');
    console.log(`- Result: ${calculatedEnd}`);
    
    console.log('\n===== END DEBUG =====\n');
    
    return {
      inputTime: timeStr,
      parsedDate: dateObj,
      endTime: calculatedEnd,
      googleCalendarFormat: gcalFormat
    };
  }

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
// Helper function to format service type for display
function formatServiceType(serviceType) {
  if (!serviceType) return 'Makeup Service';
  
  return serviceType
    .replace(/_/g, ' ')  // Replace underscores with spaces
    .replace(/\b\w/g, l => l.toUpperCase());  // Capitalize first letter of each word
}

// Helper function to format time with proper Central Time timezone for database storage
function formatTimeForDatabase(dateTimeStr) {
  console.log(`Formatting time for database: ${dateTimeStr}`);
  
  // Create date object from input
  const date = new Date(dateTimeStr);
  
  // Check if it's DST (approximate - March 2nd Sunday to November 1st Sunday)
  const month = date.getMonth();
  const day = date.getDate();
  
  // Simplified DST calculation for Central Time
  let isDST = false;
  if (month > 2 && month < 10) {
    isDST = true; // April through September is always DST
  } else if (month === 2) {
    // March - DST starts on 2nd Sunday
    const secondSunday = 14 - ((new Date(date.getFullYear(), 2, 1).getDay() + 6) % 7);
    isDST = day >= secondSunday;
  } else if (month === 10) {
    // November - DST ends on 1st Sunday
    const firstSunday = 7 - ((new Date(date.getFullYear(), 10, 1).getDay() + 6) % 7);
    isDST = day < firstSunday;
  }
  
  // Central Time offset: CDT (-05:00) or CST (-06:00)
  const offset = isDST ? '-05:00' : '-06:00';
  const result = `${dateTimeStr}${offset}`;
  
  console.log(`Converted ${dateTimeStr} to ${result} (${isDST ? 'CDT' : 'CST'})`);
  return result;
}

// Helper function to calculate end time while preserving Central Time format
function calculateEndTime(startDateTimeStr, durationMinutes) {
  try {
    console.log(`Calculating end time: start=${startDateTimeStr}, duration=${durationMinutes} minutes`);
    
    // Ensure duration is a number
    const duration = typeof durationMinutes === 'string' ? parseInt(durationMinutes, 10) : durationMinutes;
    
    // Parse the start time - input format: "2025-07-28T16:00:00"
    const startDate = new Date(startDateTimeStr);
    console.log(`Parsed start date: ${startDate.toISOString()}`);
    console.log(`Start date in Central Time: ${startDate.toLocaleString('en-US', {timeZone: 'America/Chicago'})}`);
    
    // Calculate end time by adding the duration in milliseconds
    const endDate = new Date(startDate.getTime() + (duration * 60 * 1000));
    console.log(`Calculated end date: ${endDate.toISOString()}`);
    console.log(`End date in Central Time: ${endDate.toLocaleString('en-US', {timeZone: 'America/Chicago'})}`);
    
    // Return in the same format as input (YYYY-MM-DDTHH:MM:SS)
    const year = endDate.getFullYear();
    const month = String(endDate.getMonth() + 1).padStart(2, '0');
    const day = String(endDate.getDate()).padStart(2, '0');
    const hours = String(endDate.getHours()).padStart(2, '0');
    const minutes = String(endDate.getMinutes()).padStart(2, '0');
    const seconds = String(endDate.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
  } catch (err) {
    console.error('Error calculating end time:', err);
    throw new Error(`Failed to calculate end time: ${err.message}`);
  }
}

// Helper function to format service type for display
function formatServiceType(serviceType) {
  if (!serviceType) return 'Makeup Service';
  
  return serviceType
    .replace(/_/g, ' ')  // Replace underscores with spaces
    .replace(/\b\w/g, l => l.toUpperCase());  // Capitalize first letter of each word
}

// =============================================================================
// 1. CONFIRM APPOINTMENT ENDPOINT
// =============================================================================
router.post('/confirm-appointment', async (req, res) => {
  let { 
    clientPhone, 
    clientName, 
    serviceType, 
    location, 
    specificAddress,
    startDateTime, 
    duration = 60, 
    notes = '', 
    skinType,
    skinTone,
    allergies
  } = req.body;
  
  console.log('Confirm appointment request:', JSON.stringify(req.body, null, 2));
  
  // Parse duration to ensure it's a number
  if (typeof duration === 'string') duration = parseInt(duration, 10) || 60;
  
  // Validate required fields
  if (!clientPhone || !startDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'Client phone number and start date-time are required for confirmation' 
    });
  }
  
  try {
    // Format phone number to ensure consistency
    let formattedPhone = clientPhone;
    const digits = formattedPhone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    }
    clientPhone = formattedPhone;
    
    // Get or create client
    let client = await clientOps.getByPhoneNumber(clientPhone);
    
    if (!client) {
      console.log(`Creating new client: ${clientName} (${clientPhone})`);
      client = await clientOps.createOrUpdate({ 
        phone_number: clientPhone, 
        name: clientName,
        skin_type: skinType,
        skin_tone: skinTone,
        allergies: allergies
      });
    } else {
      console.log(`Updating existing client: ${client.id} - ${client.name}`);
      // Update client data if provided and different from existing values
      const updateFields = {};
      if (clientName && clientName !== client.name) updateFields.name = clientName;
      if (skinType && skinType !== client.skin_type) updateFields.skin_type = skinType;
      if (skinTone && skinTone !== client.skin_tone) updateFields.skin_tone = skinTone;
      if (allergies && allergies !== client.allergies) updateFields.allergies = allergies;
      
      if (Object.keys(updateFields).length > 0) {
        updateFields.updated_at = new Date().toISOString();
        const { data, error } = await supabase
          .from('clients')
          .update(updateFields)
          .eq('phone_number', clientPhone)
          .select();
          
        if (!error && data[0]) {
          client = data[0];
        }
      }
    }
    
    // Get artist's Google Calendar credentials
    const { data: artist, error: artistError } = await supabase
      .from('makeup_artists')
      .select('*')
      .single();
    
    if (artistError || !artist?.refresh_token) {
      console.error('Makeup artist not found or not authorized:', artistError);
      return res.status(404).json({ 
        success: false, 
        error: 'Makeup artist not found or not authorized' 
      });
    }
    
    // Create Google Calendar client
    const oauth2Client = createOAuth2Client(artist.refresh_token);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = artist.selected_calendar_id || 'primary';
    
    // Check if this is a confirmation of an existing pending appointment
    const { data: existingAppointments, error: findError } = await supabase
      .from('appointments')
      .select('*')
      .eq('client_phone', clientPhone)
      .eq('status', 'pending_confirmation')
      .order('created_at', { ascending: false })
      .limit(1);
    
    const isConfirmation = existingAppointments && existingAppointments.length > 0;
    
    // If confirming an existing appointment, use the time from the database
    let appointmentStartTime, appointmentEndTime;
    
    if (isConfirmation) {
      const existingAppointment = existingAppointments[0];
      // Convert UTC time from database back to Central Time for Google Calendar
      appointmentStartTime = convertUTCtoCT(existingAppointment.start_time);
      appointmentEndTime = convertUTCtoCT(existingAppointment.end_time);
      
      console.log(`Using existing appointment times:`);
      console.log(`Start (CT): ${appointmentStartTime}`);
      console.log(`End (CT): ${appointmentEndTime}`);
    } else {
      // For new appointments, calculate end time
      appointmentStartTime = startDateTime;
      appointmentEndTime = calculateEndTime(startDateTime, duration);
    }
    
    console.log(`Appointment times for Google Calendar:`);
    console.log(`Start: ${appointmentStartTime} (Central Time)`);
    console.log(`End: ${appointmentEndTime} (Central Time)`);
    
    // Format service type for calendar title
    const formattedServiceType = formatServiceType(serviceType || 'Makeup Service');
    
    // Create event description with all details
    let description = `Client: ${clientName}\nPhone: ${clientPhone}\n`;
    description += `Service: ${formattedServiceType}\n`;
    description += `Location: ${location || 'Client Location'}`;
    
    if (specificAddress) {
      description += ` - ${specificAddress}`;
    }
    
    // Add skin information to description
    if (skinType) description += `\nSkin Type: ${skinType}`;
    if (skinTone) description += `\nSkin Tone: ${skinTone}`;
    if (allergies) description += `\nAllergies: ${allergies}`;
    
    if (notes) {
      description += `\n\nNotes: ${notes}`;
    }
    
    try {
      // Create Google Calendar event with proper timezone handling
      const eventDetails = {
        summary: `${formattedServiceType}: ${clientName}`,
        description,
        location: specificAddress || location || 'Client Location',
        start: {
          dateTime: appointmentStartTime,  // Use the correct time (existing or new)
          timeZone: 'America/Chicago'  // Explicitly specify Central Time
        },
        end: {
          dateTime: appointmentEndTime,   // Use the correct time (existing or new)
          timeZone: 'America/Chicago'  // Explicitly specify Central Time
        }
      };
      
      console.log('Creating Google Calendar event with details:', JSON.stringify(eventDetails, null, 2));
      
      const event = await calendar.events.insert({ 
        calendarId, 
        resource: eventDetails,
        sendUpdates: 'all'
      });
      
      console.log('Google Calendar event created successfully:', event.data.id);
      
      if (isConfirmation) {
        // UPDATE existing pending appointment
        const existingAppointment = existingAppointments[0];
        console.log('Confirming existing appointment:', existingAppointment.id);
        
        const { data: updatedAppointment, error: updateError } = await supabase
          .from('appointments')
          .update({
            status: 'confirmed',
            google_calendar_event_id: event.data.id,
            updated_at: new Date().toISOString(),
            // Update any provided fields
            ...(notes && { notes: notes }),
            ...(serviceType && { service_type: serviceType }),
            ...(location && { location_description: location }),
            ...(specificAddress && { specific_address: specificAddress })
          })
          .eq('id', existingAppointment.id)
          .select();
        
        if (updateError) {
          console.error('Error updating existing appointment:', updateError);
          return res.status(500).json({ 
            success: false, 
            error: 'Calendar event created but failed to update appointment: ' + updateError.message 
          });
        }
        
        console.log('Appointment confirmed successfully:', updatedAppointment[0].id);
        
        // Update client status to Active
        await supabase
          .from('clients')
          .update({ 
            status: 'Active',
            updated_at: new Date().toISOString()
          })
          .eq('phone_number', clientPhone);
        
        return res.status(200).json({
          success: true,
          action: 'confirm',
          eventId: event.data.id,
          eventLink: event.data.htmlLink,
          appointment: updatedAppointment[0],
          message: 'Appointment confirmed and added to calendar',
          // Return times in Central Time for user display
          appointmentTime: {
            start: appointmentStartTime,
            end: appointmentEndTime,
            timezone: 'America/Chicago'
          }
        });
      } else {
        // CREATE new appointment record with proper UTC conversion
        const startUTC = convertCTtoUTC(appointmentStartTime);
        const endUTC = convertCTtoUTC(appointmentEndTime);
        
        const appointmentData = {
          client_phone: clientPhone,
          service_type: serviceType || 'makeup_service',
          location_description: location || 'Client Location',
          specific_address: specificAddress,
          start_time: startUTC,
          end_time: endUTC,
          google_calendar_event_id: event.data.id,
          status: 'confirmed',
          duration_minutes: duration,
          notes: notes
        };
        
        console.log('Creating new appointment record:', JSON.stringify(appointmentData, null, 2));
        
        const { data: appointment, error: apptError } = await supabase
          .from('appointments')
          .insert(appointmentData)
          .select();
        
        if (apptError) {
          console.error('Error creating appointment record:', apptError);
          return res.status(500).json({ 
            success: true,
            action: 'create',
            eventId: event.data.id,
            eventLink: event.data.htmlLink,
            appointment: null,
            error: 'Calendar event created but failed to create appointment record: ' + apptError.message
          });
        }
        
        console.log('New appointment record created successfully:', appointment[0].id);
        
        return res.status(200).json({
          success: true,
          action: 'create',
          eventId: event.data.id,
          eventLink: event.data.htmlLink,
          appointment: appointment[0],
          message: 'Appointment successfully created and confirmed',
          // Return times in Central Time for user display
          appointmentTime: {
            start: appointmentStartTime,
            end: appointmentEndTime,
            timezone: 'America/Chicago'
          }
        });
      }
    } catch (calendarError) {
      console.error('Google Calendar error:', calendarError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to create event in Google Calendar: ' + calendarError.message 
      });
    }
  } catch (e) {
    console.error('Error in confirm-appointment endpoint:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =============================================================================
// 2. CANCEL APPOINTMENT ENDPOINT
// =============================================================================
router.post('/cancel-appointment', async (req, res) => {
  const { eventId, clientPhone, clientName } = req.body;
  
  console.log('Cancel appointment request:', JSON.stringify(req.body, null, 2));
  
  // Validate required fields
  if (!eventId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Event ID is required for cancellation' 
    });
  }
  
  try {
    // Format phone number if provided
    let formattedPhone = clientPhone;
    if (clientPhone) {
      const digits = formattedPhone.replace(/\D/g, '');
      if (!formattedPhone.startsWith('+')) {
        formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
      }
    }
    
    // Get artist's Google Calendar credentials
    const { data: artist, error: artistError } = await supabase
      .from('makeup_artists')
      .select('*')
      .single();
    
    if (artistError || !artist?.refresh_token) {
      console.error('Makeup artist not found or not authorized:', artistError);
      return res.status(404).json({ 
        success: false, 
        error: 'Makeup artist not found or not authorized' 
      });
    }
    
    // Create Google Calendar client
    const oauth2Client = createOAuth2Client(artist.refresh_token);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = artist.selected_calendar_id || 'primary';
    
    try {
      // Delete from Google Calendar
      await calendar.events.delete({
        calendarId,
        eventId,
        sendUpdates: 'all'
      });
      
      console.log('Google Calendar event deleted successfully');
      
      // Update appointment status in database
      const { data, error } = await supabase
        .from('appointments')
        .update({ 
          status: 'canceled', 
          updated_at: new Date().toISOString() 
        })
        .eq('google_calendar_event_id', eventId)
        .select();
      
      if (error) {
        console.error('Error updating appointment status:', error);
        return res.status(500).json({ 
          success: false, 
          error: 'Event cancelled in calendar but failed to update in database: ' + error.message 
        });
      }
      
      return res.status(200).json({
        success: true,
        action: 'cancel',
        eventId,
        appointment: data[0],
        message: 'Appointment successfully cancelled'
      });
    } catch (calendarError) {
      console.error('Google Calendar error:', calendarError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to cancel event in Google Calendar: ' + calendarError.message 
      });
    }
  } catch (e) {
    console.error('Error in cancel-appointment endpoint:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =============================================================================
// 3. RESCHEDULE APPOINTMENT ENDPOINT
// =============================================================================
router.post('/reschedule-appointment', async (req, res) => {
  let { 
    eventId, 
    clientPhone, 
    clientName, 
    newStartDateTime, 
    duration = 60, 
    serviceType,
    location,
    specificAddress
  } = req.body;
  
  console.log('Reschedule appointment request:', JSON.stringify(req.body, null, 2));
  
  // Parse duration to ensure it's a number
  if (typeof duration === 'string') duration = parseInt(duration, 10) || 60;
  
  // Validate required fields
  if (!eventId || !newStartDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'Event ID and new start date-time are required for rescheduling' 
    });
  }
  
  try {
    // Format phone number if provided
    let formattedPhone = clientPhone;
    if (clientPhone) {
      const digits = formattedPhone.replace(/\D/g, '');
      if (!formattedPhone.startsWith('+')) {
        formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
      }
    }
    
    // Get artist's Google Calendar credentials
    const { data: artist, error: artistError } = await supabase
      .from('makeup_artists')
      .select('*')
      .single();
    
    if (artistError || !artist?.refresh_token) {
      console.error('Makeup artist not found or not authorized:', artistError);
      return res.status(404).json({ 
        success: false, 
        error: 'Makeup artist not found or not authorized' 
      });
    }
    
    // Create Google Calendar client
    const oauth2Client = createOAuth2Client(artist.refresh_token);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = artist.selected_calendar_id || 'primary';
    
    try {
      // Get existing event
      const existingEvent = await calendar.events.get({
        calendarId,
        eventId
      });
      
      if (!existingEvent.data) {
        console.error('Appointment not found in calendar');
        return res.status(404).json({
          success: false,
          error: 'Appointment not found in calendar'
        });
      }
      
      // Calculate new end time
      const newEndDateTime = calculateEndTime(newStartDateTime, duration);
      
      console.log(`Rescheduling to new times:`);
      console.log(`New Start: ${newStartDateTime} (Central Time)`);
      console.log(`New End: ${newEndDateTime} (Central Time)`);
      
      // Format service type for calendar title if provided
      const formattedServiceType = formatServiceType(serviceType);
      
      // Update the event in Google Calendar
      const updatedEvent = await calendar.events.update({
        calendarId,
        eventId,
        resource: {
          ...existingEvent.data,
          summary: serviceType ? `${formattedServiceType}: ${clientName}` : existingEvent.data.summary,
          start: {
            dateTime: newStartDateTime,  // Use format: "2025-07-28T16:00:00"
            timeZone: 'America/Chicago'  // Explicitly specify Central Time
          },
          end: {
            dateTime: newEndDateTime,    // Calculated end time in same format
            timeZone: 'America/Chicago'  // Explicitly specify Central Time
          },
          ...(location && { location: specificAddress || location })
        },
        sendUpdates: 'all'
      });
      
      console.log('Google Calendar event updated successfully');
      
      // Convert Central Time to UTC for database storage
      const startUTC = convertCTtoUTC(newStartDateTime);
      const endUTC = convertCTtoUTC(newEndDateTime);
      
      console.log(`Time conversion for database:`);
      console.log(`Start (CT): ${newStartDateTime} -> UTC: ${startUTC}`);
      console.log(`End (CT): ${newEndDateTime} -> UTC: ${endUTC}`);
      
      // Update the appointment in the database
      const updateData = {
        start_time: startUTC,
        end_time: endUTC,
        updated_at: new Date().toISOString()
      };
      
      // Add optional fields if provided
      if (serviceType) updateData.service_type = serviceType;
      if (location) updateData.location_description = location;
      if (specificAddress) updateData.specific_address = specificAddress;
      
      const { data, error } = await supabase
        .from('appointments')
        .update(updateData)
        .eq('google_calendar_event_id', eventId)
        .select();
      
      if (error) {
        console.error('Error updating appointment in database:', error);
        return res.status(500).json({ 
          success: false, 
          error: 'Event rescheduled in calendar but failed to update in database: ' + error.message 
        });
      }
      
      return res.status(200).json({
        success: true,
        action: 'reschedule',
        eventId: updatedEvent.data.id,
        eventLink: updatedEvent.data.htmlLink,
        appointment: data[0],
        newStartTime: newStartDateTime,
        newEndTime: newEndDateTime,
        message: 'Appointment successfully rescheduled',
        // Return times in Central Time for user display
        appointmentTime: {
          start: newStartDateTime,
          end: newEndDateTime,
          timezone: 'America/Chicago'
        }
      });
    } catch (calendarError) {
      console.error('Google Calendar error:', calendarError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to reschedule event in Google Calendar: ' + calendarError.message 
      });
    }
  } catch (e) {
    console.error('Error in reschedule-appointment endpoint:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});


  router.post('/update-client-info', async (req, res) => {
    const { 
      phoneNumber, 
      name,
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
      
      // Prepare client data
      const clientData = {
        phone_number: formattedPhone
      };
      
      // Only include provided fields
      if (name) clientData.name = name;
      if (email) clientData.email = email;
      if (skinType) clientData.skin_type = skinType;
      if (skinTone) clientData.skin_tone = skinTone;
      if (allergies) clientData.allergies = allergies;
      if (preferredServiceType) clientData.preferred_service_type = preferredServiceType;
      if (specialNotes) clientData.special_notes = specialNotes;
      
      // Create or update client
      const client = await clientOps.createOrUpdate(clientData);
      
      if (!client) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to update client information' 
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Client information updated successfully',
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
        }
      });
    } catch (e) {
      console.error('Error in update-client-info:', e);
      return res.status(500).json({ 
        success: false, 
        error: e.message 
      });
    }
  });
  
  // Simplified check-availability endpoint without serviceId requirement
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
      
      // Parse specific start time from request - already in Central Time
      // Input format: 2025-05-16T13:00:00 (already in CT)
      const requestedStart = new Date(startDateTime);
      const requestedEnd = endDateTime 
        ? new Date(endDateTime)
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
      slotDurationMinutes = 60
    } = req.body;
    
    if (!currentTimestamp) {
      return res.status(400).json({ 
        success: false, 
        error: 'Current timestamp is required' 
      });
    }
    
    try {
      // Use the provided duration directly
      const duration = slotDurationMinutes;
      
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
      
      // Helper function to find available slots using CT time directly
      async function findNextAvailableSlots(startFrom, numSlots, slotMinutes) {
        const results = [];
        
        // Parse the start time directly - ASSUMING INPUT IS ALREADY IN CENTRAL TIME
        // Input format: 2025-05-16T13:00:00 (already in CT)
        let searchTime = new Date(startFrom);
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
        client:clients!appointments_client_phone_fkey(name, phone_number, email, skin_type, skin_tone, allergies)
      `)
      .order('start_time', { ascending: true });
    
    // Filter by client phone if provided
    if (clientPhone) {
      // Format the phone number to match your database format
      let formattedPhone = clientPhone;
      const digits = formattedPhone.replace(/\D/g, '');
      if (!formattedPhone.startsWith('+')) {
        formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
      }
      query = query.eq('client_phone', formattedPhone);
    }
    
    // Filter by status
    if (includeCompleted === 'true' || includeCompleted === true) {
      query = query.in('status', ['pending_confirmation', 'pending', 'confirmed', 'completed']);
    } else {
      query = query.in('status', ['pending_confirmation', 'pending', 'confirmed']);
    }
    
    // Only get future appointments
    query = query.gte('start_time', new Date().toISOString());
    
    const { data, error } = await query;
    
    if (error) {
      console.error('Error fetching pending appointments:', error);
      throw error;
    }
    
    // Process the data to add any additional group booking info if needed
    const processedAppointments = [];
    
    for (const appointment of data || []) {
      // Convert UTC times from database back to Central Time for display
      if (appointment.start_time) {
        appointment.start_time_ct = convertUTCtoCT(appointment.start_time);
      }
      
      if (appointment.end_time) {
        appointment.end_time_ct = convertUTCtoCT(appointment.end_time);
      }
      
      // Add group_bookings as an empty array since you don't have a separate table
      // The group clients info is stored in the group_clients jsonb field
      appointment.group_bookings = appointment.group_clients || [];
      
      // Add service and location as null since they're stored as text fields
      appointment.service = appointment.service_type ? {
        name: appointment.service_type,
        base_price: null,
        duration_minutes: appointment.duration_minutes || 60
      } : null;
      
      appointment.location = appointment.location_description ? {
        name: appointment.location_description,
        travel_fee: null
      } : null;
      
      processedAppointments.push(appointment);
    }
    
    return res.status(200).json({
      success: true,
      appointments: processedAppointments,
      count: processedAppointments.length,
      timezone: 'America/Chicago' // Indicate that CT times are provided
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

  router.post('/store-pending-appointment', async (req, res) => {
    const { 
      clientPhone, 
      clientName = "New Client", 
      serviceType = "Makeup Service", 
      location = "Client's Location", 
      specificAddress,
      startDateTime, 
      duration = 60, 
      notes = '', 
      skinType,
      skinTone,
      allergies
    } = req.body;
    
    if (!clientPhone || !startDateTime) {
      return res.status(400).json({ 
        success: false, 
        error: 'Client phone and start date-time are required' 
      });
    }
    
    try {
      // Format phone number
      let formattedPhone = clientPhone;
      const digits = formattedPhone.replace(/\D/g, '');
      if (!formattedPhone.startsWith('+')) {
        formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
      }
      
      // Get or create client
      let client = await clientOps.getByPhoneNumber(formattedPhone);
      
      if (!client) {
        console.log(`Creating new client: ${clientName} (${formattedPhone})`);
        client = await clientOps.createOrUpdate({ 
          phone_number: formattedPhone, 
          name: clientName,
          skin_type: skinType,
          skin_tone: skinTone,
          allergies: allergies,
          status: 'Lead'
        });
      } else {
        // Update client status to 'Needs Confirmation'
        const { data, error } = await supabase
          .from('clients')
          .update({ 
            status: 'Needs Confirmation',
            updated_at: new Date().toISOString()
          })
          .eq('phone_number', formattedPhone)
          .select();
          
        if (!error && data[0]) {
          client = data[0];
        }
      }
      
      // Calculate end time in Central Time
      const endDateTime = calculateEndTime(startDateTime, duration);
      
      // Convert Central Time to UTC for database storage
      // Input format: "2025-07-17T14:00:00" (assumed to be Central Time)
      const startUTC = convertCTtoUTC(startDateTime);
      const endUTC = convertCTtoUTC(endDateTime);
      
      console.log(`Time conversion debug:`);
      console.log(`Input startDateTime (CT): ${startDateTime}`);
      console.log(`Calculated endDateTime (CT): ${endDateTime}`);
      console.log(`Storing start_time (UTC): ${startUTC}`);
      console.log(`Storing end_time (UTC): ${endUTC}`);
      
      // Create pending appointment record with UTC times
      const appointmentData = {
        client_phone: formattedPhone,
        service_type: serviceType,
        location_description: location,
        specific_address: specificAddress,
        start_time: startUTC,
        end_time: endUTC,
        duration_minutes: duration,
        status: 'pending_confirmation',
        notes: notes,
        google_calendar_event_id: null
      };
      
      console.log('Creating pending appointment:', JSON.stringify(appointmentData, null, 2));
      
      const { data: appointment, error: apptError } = await supabase
        .from('appointments')
        .insert(appointmentData)
        .select();
      
      if (apptError) {
        console.error('Error creating pending appointment:', apptError);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to store pending appointment: ' + apptError.message 
        });
      }
      
      console.log('Pending appointment created successfully:', appointment[0].id);
      
      return res.status(200).json({
        success: true,
        action: 'store_pending',
        appointmentId: appointment[0].id,
        appointment: appointment[0],
        client: client,
        message: 'Pending appointment stored successfully. Awaiting confirmation.',
        // Return times in Central Time for user display
        appointmentTime: {
          start: startDateTime,
          end: endDateTime,
          timezone: 'America/Chicago'
        }
      });
    } catch (e) {
      console.error('Error in store-pending-appointment:', e);
      return res.status(500).json({ 
        success: false, 
        error: e.message 
      });
    }
  });
  
  // 2. Update client status
  router.post('/update-client-status', async (req, res) => {
    const { phoneNumber, status, notes } = req.body;
    
    if (!phoneNumber || !status) {
      return res.status(400).json({ 
        success: false, 
        error: 'Phone number and status are required' 
      });
    }
    
    // Validate status
    const validStatuses = ['Lead', 'Active', 'Needs Confirmation', 'Payment Due'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` 
      });
    }
    
    try {
      // Format phone number
      let formattedPhone = phoneNumber;
      const digits = formattedPhone.replace(/\D/g, '');
      if (!formattedPhone.startsWith('+')) {
        formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
      }
      
      // Update client status
      const updateData = {
        status: status,
        updated_at: new Date().toISOString()
      };
      
      if (notes) {
        updateData.status_notes = notes;
      }
      
      const { data, error } = await supabase
        .from('clients')
        .update(updateData)
        .eq('phone_number', formattedPhone)
        .select();
      
      if (error) {
        console.error('Error updating client status:', error);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to update client status: ' + error.message 
        });
      }
      
      if (!data || data.length === 0) {
        return res.status(404).json({ 
          success: false, 
          error: 'Client not found' 
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Client status updated successfully',
        client: data[0],
        newStatus: status
      });
    } catch (e) {
      console.error('Error in update-client-status:', e);
      return res.status(500).json({ 
        success: false, 
        error: e.message 
      });
    }
  });
  
  // 3. Get client status and appointment info
  router.get('/get-client-status', async (req, res) => {
    const { phoneNumber } = req.query;
    
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
      
      // Get client
      const client = await clientOps.getByPhoneNumber(formattedPhone);
      
      if (!client) {
        return res.status(404).json({ 
          success: false, 
          error: 'Client not found' 
        });
      }
      
      // Get pending appointments
      const { data: pendingAppointments, error: pendingError } = await supabase
        .from('appointments')
        .select('*')
        .eq('client_phone', formattedPhone)
        .eq('status', 'pending_confirmation')
        .order('created_at', { ascending: false });
      
      // Get upcoming confirmed appointments
      const { data: upcomingAppointments, error: upcomingError } = await supabase
        .from('appointments')
        .select('*')
        .eq('client_phone', formattedPhone)
        .in('status', ['pending', 'confirmed'])
        .gte('start_time', new Date().toISOString())
        .order('start_time', { ascending: true });
      
      // Get appointment history
      const { data: appointmentHistory, error: historyError } = await supabase
        .from('appointments')
        .select('*')
        .eq('client_phone', formattedPhone)
        .order('created_at', { ascending: false })
        .limit(5);
      
      return res.status(200).json({
        success: true,
        client: client,
        pendingAppointments: pendingAppointments || [],
        upcomingAppointments: upcomingAppointments || [],
        appointmentHistory: appointmentHistory || [],
        summary: {
          status: client.status,
          hasPendingConfirmations: (pendingAppointments || []).length > 0,
          hasUpcomingAppointments: (upcomingAppointments || []).length > 0,
          totalAppointments: (appointmentHistory || []).length
        }
      });
    } catch (e) {
      console.error('Error in get-client-status:', e);
      return res.status(500).json({ 
        success: false, 
        error: e.message 
      });
    }
  });

  router.post('/confirm-pending-appointment', async (req, res) => {
    const { 
      appointmentId,
      clientPhone,
      clientName
    } = req.body;
    
    if (!appointmentId && !clientPhone) {
      return res.status(400).json({ 
        success: false, 
        error: 'Appointment ID or client phone is required' 
      });
    }
    
    try {
      // Get the pending appointment
      let appointment;
      
      if (appointmentId) {
        const { data, error } = await supabase
          .from('appointments')
          .select('*')
          .eq('id', appointmentId)
          .eq('status', 'pending_confirmation')
          .single();
          
        if (error || !data) {
          return res.status(404).json({ 
            success: false, 
            error: 'Pending appointment not found' 
          });
        }
        appointment = data;
      } else {
        // Find by client phone
        const { data, error } = await supabase
          .from('appointments')
          .select('*')
          .eq('client_phone', clientPhone)
          .eq('status', 'pending_confirmation')
          .order('created_at', { ascending: false })
          .limit(1);
          
        if (error || !data || data.length === 0) {
          return res.status(404).json({ 
            success: false, 
            error: 'No pending appointments found for this client' 
          });
        }
        appointment = data[0];
      }
      
      // Get artist's Google Calendar credentials
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
      
      // Create event description
      let description = `Client: ${clientName || 'Client'}\nPhone: ${appointment.client_phone}\n`;
      description += `Service: ${appointment.service_type || 'Makeup Service'}\n`;
      description += `Location: ${appointment.location_description || 'Client Location'}`;
      
      if (appointment.specific_address) {
        description += ` (${appointment.specific_address})`;
      }
      
      if (appointment.notes) {
        description += `\n\nNotes: ${appointment.notes}`;
      }
      
      // Create Google Calendar event
      const eventDetails = {
        summary: `${appointment.service_type || 'Makeup Service'}: ${clientName || 'Client'}`,
        description,
        location: appointment.specific_address || appointment.location_description,
        start: {
          dateTime: appointment.start_time,
          timeZone: 'America/Chicago'
        },
        end: {
          dateTime: appointment.end_time,
          timeZone: 'America/Chicago'
        }
      };
      
      const event = await calendar.events.insert({ 
        calendarId, 
        resource: eventDetails,
        sendUpdates: 'all'
      });
      
      // Update appointment status
      const { data: updatedAppointment, error: updateError } = await supabase
        .from('appointments')
        .update({
          status: 'confirmed',
          artist_confirmation_status: 'confirmed',
          google_calendar_event_id: event.data.id,
          updated_at: new Date().toISOString()
        })
        .eq('id', appointment.id)
        .select();
      
      if (updateError) {
        console.error('Error updating appointment:', updateError);
        return res.status(500).json({ 
          success: false, 
          error: 'Calendar event created but failed to update appointment' 
        });
      }
      
      // Update client status to Active
      await supabase
        .from('clients')
        .update({ 
          status: 'Active',
          updated_at: new Date().toISOString()
        })
        .eq('phone_number', appointment.client_phone);
      
      return res.status(200).json({
        success: true,
        action: 'confirm',
        eventId: event.data.id,
        eventLink: event.data.htmlLink,
        appointment: updatedAppointment[0],
        message: 'Appointment confirmed and added to calendar'
      });
    } catch (e) {
      console.error('Error in confirm-pending-appointment:', e);
      return res.status(500).json({ 
        success: false, 
        error: e.message 
      });
    }
  });

module.exports = router;

// Export helper functions for testing
module.exports.convertCTtoUTC = convertCTtoUTC;
module.exports.convertUTCtoCT = convertUTCtoCT;