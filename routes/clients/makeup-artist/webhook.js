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

// Helper function to convert Central Time to Central Time format for database storage
function convertCTtoUTC(centralTimeString) {
  // Since we want to store in Central Time format, just return the input
  // but ensure it's in the correct format
  const dateCT = new Date(centralTimeString);
  
  // Format as YYYY-MM-DDTHH:MM:SS
  const year = dateCT.getFullYear();
  const month = String(dateCT.getMonth() + 1).padStart(2, '0');
  const day = String(dateCT.getDate()).padStart(2, '0');
  const hours = String(dateCT.getHours()).padStart(2, '0');
  const minutes = String(dateCT.getMinutes()).padStart(2, '0');
  const seconds = String(dateCT.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

// Helper function to convert database time to Central Time for display
function convertUTCtoCT(databaseTimeString) {
  // Since we're storing in Central Time format, just return the input
  // but ensure it's in the correct format
  const date = new Date(databaseTimeString);
  
  // Format as YYYY-MM-DDTHH:MM:SS
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  
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
      
      // Format times from database (stored in Central Time format)
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
      // Use the Central Time from database directly for Google Calendar
      appointmentStartTime = convertUTCtoCT(existingAppointment.start_time);
      appointmentEndTime = convertUTCtoCT(existingAppointment.end_time);
      
      console.log(`Using existing appointment times from database:`);
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
        // CREATE new appointment record with Central Time format
        const startTimeForDB = convertCTtoUTC(appointmentStartTime);
        const endTimeForDB = convertCTtoUTC(appointmentEndTime);
        
        const appointmentData = {
          client_phone: clientPhone,
          service_type: serviceType || 'makeup_service',
          location_description: location || 'Client Location',
          specific_address: specificAddress,
          start_time: startTimeForDB,
          end_time: endTimeForDB,
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
      
      // Store times in Central Time format for database
      const startTimeForDB = convertCTtoUTC(newStartDateTime);
      const endTimeForDB = convertCTtoUTC(newEndDateTime);
      
      console.log(`Time storage for database:`);
      console.log(`Start (CT): ${newStartDateTime} -> DB: ${startTimeForDB}`);
      console.log(`End (CT): ${newEndDateTime} -> DB: ${endTimeForDB}`);
      
      // Update the appointment in the database
      const updateData = {
        start_time: startTimeForDB,
        end_time: endTimeForDB,
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
      // Format times from database (stored in Central Time format)
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
      
      // Store times in Central Time format for database
      // Input format: "2025-07-17T14:00:00" (Central Time)
      const startTimeForDB = convertCTtoUTC(startDateTime);
      const endTimeForDB = convertCTtoUTC(endDateTime);
      
      console.log(`Time storage debug:`);
      console.log(`Input startDateTime (CT): ${startDateTime}`);
      console.log(`Calculated endDateTime (CT): ${endDateTime}`);
      console.log(`Storing start_time (CT): ${startTimeForDB}`);
      console.log(`Storing end_time (CT): ${endTimeForDB}`);
      
      // Create pending appointment record with Central Time format
      const appointmentData = {
        client_phone: formattedPhone,
        service_type: serviceType,
        location_description: location,
        specific_address: specificAddress,
        start_time: startTimeForDB,
        end_time: endTimeForDB,
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

  // Enhanced conversation history endpoint for webhook.js
// Add this to your routes/clients/makeup-artist/webhook.js file

// Enhanced conversation history with AI-powered context analysis
router.get('/conversation/history-with-context', async (req, res) => {
  const { phoneNumber, limit = 30 } = req.query;
  
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
    
    // Get conversation session and messages directly from database for better performance
    const { data: sessionData, error: sessionError } = await supabase
      .from('conversation_sessions')
      .select('id, created_at, last_active')
      .eq('phone_number', formattedPhone)
      .single();
    
    let history = [];
    let sessionInfo = null;
    
    if (sessionData && !sessionError) {
      sessionInfo = sessionData;
      
      // Get messages for this session
      const { data: messages, error: messagesError } = await supabase
        .from('conversation_messages')
        .select('id, role, content, metadata, created_at, temp_messages')
        .eq('session_id', sessionData.id)
        .order('created_at', { ascending: true })
        .limit(parseInt(limit));
      
      if (!messagesError && messages) {
        history = messages;
      }
    }
    
    // Get client info for additional context
    const { data: clientData, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('phone_number', formattedPhone)
      .single();
    
    const client = clientData || null;
    
    // Get pending appointments for context
    const { data: pendingAppointments, error: appointmentsError } = await supabase
      .from('appointments')
      .select('*')
      .eq('client_phone', formattedPhone)
      .in('status', ['pending_confirmation', 'pending', 'confirmed'])
      .gte('start_time', new Date().toISOString())
      .order('start_time', { ascending: true });
    
    // Get recent completed appointments for relationship context
    const { data: recentAppointments, error: recentError } = await supabase
      .from('appointments')
      .select('service_type, start_time, status')
      .eq('client_phone', formattedPhone)
      .in('status', ['completed'])
      .order('start_time', { ascending: false })
      .limit(3);
    
    // Analyze conversation context
    const contextAnalysis = analyzeConversationContext(
      history || [], 
      client, 
      pendingAppointments || [], 
      recentAppointments || [],
      sessionInfo
    );
    
    return res.status(200).json({
      success: true,
      rawHistory: history || [],
      conversationContext: contextAnalysis.context,
      responseGuidance: contextAnalysis.guidance,
      relationshipMemory: contextAnalysis.relationship,
      sessionInfo: {
        sessionId: sessionInfo?.id || null,
        sessionCreated: sessionInfo?.created_at || null,
        lastActive: sessionInfo?.last_active || null,
        conversationAge: sessionInfo ? Math.floor((new Date() - new Date(sessionInfo.created_at)) / (1000 * 60 * 60)) : null // hours
      },
      count: (history || []).length
    });
  } catch (e) {
    console.error('Error in enhanced conversation history:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// AI-powered conversation context analysis
function analyzeConversationContext(messages, client, pendingAppointments, recentAppointments = [], sessionInfo = null) {
  const analysis = {
    context: {},
    guidance: {},
    relationship: {}
  };
  
  try {
    // Join all message content for analysis
    const conversationText = messages
      .map(msg => `${msg.role}: ${msg.content}`)
      .join('\n');
    
    // CONVERSATION CONTEXT ANALYSIS
    analysis.context = {
      questionsAlreadyAsked: extractQuestionsAsked(messages),
      clientPreferences: extractClientPreferences(conversationText, client),
      conversationFlow: analyzeConversationFlow(messages, pendingAppointments),
      clientMood: analyzeClientMood(conversationText),
      topicsDiscussed: extractTopicsDiscussed(conversationText),
      conversationAge: sessionInfo ? Math.floor((new Date() - new Date(sessionInfo.created_at)) / (1000 * 60 * 60)) : 0, // hours
      isActiveConversation: sessionInfo ? (new Date() - new Date(sessionInfo.last_active)) < (30 * 60 * 1000) : false // within 30 minutes
    };
    
    // RESPONSE GUIDANCE
    analysis.guidance = generateResponseGuidance(analysis.context, messages, recentAppointments);
    
    // RELATIONSHIP MEMORY
    analysis.relationship = buildRelationshipMemory(client, messages, pendingAppointments, recentAppointments);
    
    return analysis;
  } catch (error) {
    console.error('Error in context analysis:', error);
    // Return basic structure if analysis fails
    return {
      context: { questionsAlreadyAsked: [], clientPreferences: {} },
      guidance: { toneToUse: "warm and professional" },
      relationship: { isReturningClient: false }
    };
  }
}

// Extract what questions have been asked
function extractQuestionsAsked(messages) {
  const questions = [];
  const questionPatterns = [
    { pattern: /when.*(is|'s).*your.*(occasion|event|wedding|graduation|birthday)/i, type: 'date_time' },
    { pattern: /what.*(occasion|event|celebrating)/i, type: 'occasion' },
    { pattern: /where.*(location|address)/i, type: 'location' },
    { pattern: /what.*(service|look|style).*prefer/i, type: 'service_preference' },
    { pattern: /skin.*(type|tone|allergies)/i, type: 'skin_info' },
    { pattern: /budget|price|cost|fee/i, type: 'pricing' },
    { pattern: /would you like.*more|want.*know.*about/i, type: 'engagement_question' }
  ];
  
  messages.forEach(msg => {
    if (msg.role === 'assistant') {
      questionPatterns.forEach(({ pattern, type }) => {
        if (pattern.test(msg.content)) {
          questions.push(type);
        }
      });
    }
  });
  
  return [...new Set(questions)]; // Remove duplicates
}

// Extract client preferences and details
function extractClientPreferences(conversationText, client) {
  const preferences = {};
  
  // Extract occasion
  const occasionMatch = conversationText.match(/(?:wedding|graduation|birthday|anniversary|date night|photoshoot|prom|baby shower|business event)/i);
  if (occasionMatch) preferences.occasion = occasionMatch[0].toLowerCase();
  
  // Extract service preferences
  const serviceMatch = conversationText.match(/(?:minimalistic|soft party|bridal|natural|glam|editorial)/i);
  if (serviceMatch) preferences.serviceStyle = serviceMatch[0].toLowerCase();
  
  // Extract budget concerns
  preferences.budgetConcern = /budget|expensive|cost|affordable|cheap|price/i.test(conversationText);
  
  // Extract location/travel concerns
  preferences.travelConcern = /travel|distance|far|location|address/i.test(conversationText);
  
  // Extract timing preferences
  const timePreference = conversationText.match(/(?:morning|afternoon|evening|early|late)/i);
  if (timePreference) preferences.timePreference = timePreference[0].toLowerCase();
  
  // Add client database info
  if (client) {
    if (client.skin_type) preferences.skinType = client.skin_type;
    if (client.skin_tone) preferences.skinTone = client.skin_tone;
    if (client.allergies) preferences.allergies = client.allergies;
  }
  
  return preferences;
}

// Analyze conversation flow and stage
function analyzeConversationFlow(messages, pendingAppointments) {
  const flow = {
    currentStage: 'greeting',
    completedSteps: [],
    nextLogicalStep: 'identify_occasion',
    blockers: [],
    hasDateTimeConfirmed: false,
    hasServiceDiscussed: false,
    hasAddressCollected: false,
    hasPendingAppointment: (pendingAppointments && pendingAppointments.length > 0)
  };
  
  const conversationText = messages.map(m => m.content).join(' ').toLowerCase();
  
  // Check completed steps
  if (/hi|hello|i'm rihanna/i.test(conversationText)) {
    flow.completedSteps.push('greeting');
  }
  
  if (/wedding|graduation|birthday|anniversary|photoshoot|prom|baby shower/i.test(conversationText)) {
    flow.completedSteps.push('occasion_identified');
  }
  
  if (/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(conversationText)) {
    flow.completedSteps.push('date_time_discussed');
  }
  
  if (/available|availability|check.*schedule/i.test(conversationText)) {
    flow.completedSteps.push('availability_checked');
    flow.hasDateTimeConfirmed = true;
  }
  
  if (/minimalistic|soft party|bridal|glam.*\$|service.*\$|price/i.test(conversationText)) {
    flow.completedSteps.push('service_discussed');
    flow.hasServiceDiscussed = true;
  }
  
  if (/address|street|city|zip/i.test(conversationText)) {
    flow.completedSteps.push('address_collected');
    flow.hasAddressCollected = true;
  }
  
  // Determine current stage
  if (!flow.completedSteps.includes('greeting')) {
    flow.currentStage = 'greeting';
    flow.nextLogicalStep = 'warm_introduction';
  } else if (!flow.completedSteps.includes('occasion_identified')) {
    flow.currentStage = 'occasion_collection';
    flow.nextLogicalStep = 'ask_about_occasion';
  } else if (!flow.hasDateTimeConfirmed) {
    flow.currentStage = 'date_collection';
    flow.nextLogicalStep = 'collect_date_time';
  } else if (!flow.hasServiceDiscussed) {
    flow.currentStage = 'service_discussion';
    flow.nextLogicalStep = 'recommend_services';
  } else if (!flow.hasAddressCollected) {
    flow.currentStage = 'address_collection';
    flow.nextLogicalStep = 'collect_address';
  } else {
    flow.currentStage = 'booking_completion';
    flow.nextLogicalStep = 'send_form_or_payment_info';
  }
  
  return flow;
}

// Analyze client mood and communication style
function analyzeClientMood(conversationText) {
  const mood = {
    enthusiasm: 'medium',
    concerns: [],
    communicationStyle: 'casual',
    decisionReadiness: 'considering'
  };
  
  // Detect enthusiasm
  if (/excited|amazing|perfect|love|awesome|great/i.test(conversationText)) {
    mood.enthusiasm = 'high';
  } else if (/okay|sure|maybe|i guess/i.test(conversationText)) {
    mood.enthusiasm = 'low';
  }
  
  // Detect concerns
  if (/expensive|budget|cost|afford/i.test(conversationText)) {
    mood.concerns.push('pricing');
  }
  if (/far|travel|distance|location/i.test(conversationText)) {
    mood.concerns.push('travel');
  }
  if (/time|schedule|busy|available/i.test(conversationText)) {
    mood.concerns.push('scheduling');
  }
  
  // Detect communication style
  if (/please|thank you|would you mind/i.test(conversationText)) {
    mood.communicationStyle = 'formal';
  } else if (/yeah|yep|nah|lol|haha/i.test(conversationText)) {
    mood.communicationStyle = 'very_casual';
  }
  
  // Detect decision readiness
  if (/book|schedule|let's do it|yes|sounds good/i.test(conversationText)) {
    mood.decisionReadiness = 'ready';
  } else if (/maybe|thinking|not sure|let me/i.test(conversationText)) {
    mood.decisionReadiness = 'hesitant';
  }
  
  return mood;
}

// Extract topics that have been discussed
function extractTopicsDiscussed(conversationText) {
  const topics = [];
  const topicPatterns = [
    { pattern: /price|cost|fee|budget|\$/i, topic: 'pricing' },
    { pattern: /travel|distance|location|address/i, topic: 'travel_logistics' },
    { pattern: /minimalistic|soft party|bridal|glam|service/i, topic: 'services' },
    { pattern: /skin|allergies|tone|type/i, topic: 'skin_consultation' },
    { pattern: /portfolio|instagram|photos|work/i, topic: 'portfolio' },
    { pattern: /time|duration|how long/i, topic: 'service_duration' },
    { pattern: /what.*included|process|preparation/i, topic: 'service_details' },
    { pattern: /deposit|payment|venmo|zelle/i, topic: 'payment' }
  ];
  
  topicPatterns.forEach(({ pattern, topic }) => {
    if (pattern.test(conversationText)) {
      topics.push(topic);
    }
  });
  
  return topics;
}

// Generate response guidance based on context
function generateResponseGuidance(context, messages, recentAppointments = []) {
  const guidance = {
    toneToUse: 'warm and professional',
    shouldReference: [],
    shouldAvoid: [],
    conversationOpeners: [],
    naturalTransitions: '',
    priorityAction: '',
    clientType: 'new'
  };
  
  // Determine client type
  if (recentAppointments && recentAppointments.length > 0) {
    guidance.clientType = 'returning';
  } else if (context.conversationFlow?.hasPendingAppointment) {
    guidance.clientType = 'pending_confirmation';
  }
  
  // Determine tone based on mood and stage
  if (context.clientMood?.enthusiasm === 'high') {
    guidance.toneToUse = 'enthusiastic and supportive';
  } else if (context.clientMood?.concerns?.includes('pricing')) {
    guidance.toneToUse = 'understanding and reassuring about value';
  } else if (context.conversationFlow?.currentStage === 'date_collection') {
    guidance.toneToUse = 'friendly but focused on scheduling';
  } else if (guidance.clientType === 'returning') {
    guidance.toneToUse = 'warm and familiar, acknowledging past service';
  }
  
  // What to reference
  if (context.clientPreferences?.occasion) {
    guidance.shouldReference.push(`their ${context.clientPreferences.occasion}`);
  }
  if (context.clientMood?.concerns?.length > 0) {
    guidance.shouldReference.push('their concerns about ' + context.clientMood.concerns.join(' and '));
  }
  if (recentAppointments && recentAppointments.length > 0) {
    guidance.shouldReference.push(`their previous ${recentAppointments[0].service_type} service`);
  }
  
  // What to avoid
  if (context.questionsAlreadyAsked.includes('engagement_question')) {
    guidance.shouldAvoid.push('asking "want to know more?" again');
  }
  if (context.questionsAlreadyAsked.includes('pricing') && context.topicsDiscussed?.includes('pricing')) {
    guidance.shouldAvoid.push('repeating pricing information');
  }
  if (context.questionsAlreadyAsked.length > 0) {
    guidance.shouldAvoid.push('repeating questions about: ' + context.questionsAlreadyAsked.join(', '));
  }
  
  // Generate conversation openers based on client type and context
  if (guidance.clientType === 'returning') {
    guidance.conversationOpeners.push('So great to hear from you again!');
    if (recentAppointments.length > 0) {
      guidance.conversationOpeners.push(`Hope you loved how the ${recentAppointments[0].service_type} turned out!`);
    }
  }
  
  if (context.clientPreferences?.occasion) {
    guidance.conversationOpeners.push(`For your ${context.clientPreferences.occasion}...`);
    guidance.conversationOpeners.push(`Since it's your ${context.clientPreferences.occasion}...`);
  }
  
  if (context.clientMood?.concerns?.includes('pricing')) {
    guidance.conversationOpeners.push('I totally understand the budget consideration...');
    guidance.conversationOpeners.push('Let me help you find something that works within your budget...');
  }
  
  // Priority action based on stage and context
  if (context.conversationFlow?.currentStage === 'date_collection') {
    guidance.priorityAction = 'Get specific date and time before discussing anything else';
  } else if (context.conversationFlow?.currentStage === 'service_discussion') {
    if (guidance.clientType === 'returning') {
      guidance.priorityAction = 'Reference their previous service experience and recommend based on new occasion';
    } else {
      guidance.priorityAction = 'Use knowledge base to answer service questions and recommend based on occasion';
    }
  } else if (context.conversationFlow?.hasPendingAppointment) {
    guidance.priorityAction = 'Address the pending appointment status first';
  }
  
  // Natural transition guidance
  if (context.conversationFlow?.nextLogicalStep) {
    guidance.naturalTransitions = `Focus on ${context.conversationFlow.nextLogicalStep.replace('_', ' ')} as the next step`;
  }
  
  return guidance;
}

// Build relationship memory
function buildRelationshipMemory(client, messages, pendingAppointments, recentAppointments = []) {
  const memory = {
    isReturningClient: false,
    previousServices: [],
    knownPreferences: {},
    communicationHistory: {},
    currentBookingStatus: 'new_inquiry',
    serviceHistory: []
  };
  
  if (client) {
    // Check if returning client based on status or existing appointments
    memory.isReturningClient = client.status === 'Active' || recentAppointments.length > 0;
    memory.clientStatus = client.status;
    memory.lastContactDate = client.last_contact_date;
    memory.clientSince = client.created_at;
    
    memory.knownPreferences = {
      skinType: client.skin_type,
      skinTone: client.skin_tone,
      allergies: client.allergies,
      preferredServiceType: client.preferred_service_type,
      specialNotes: client.special_notes
    };
    
    // Remove null/undefined values
    Object.keys(memory.knownPreferences).forEach(key => {
      if (memory.knownPreferences[key] === null || memory.knownPreferences[key] === undefined) {
        delete memory.knownPreferences[key];
      }
    });
  }
  
  // Process recent appointments for service history
  if (recentAppointments && recentAppointments.length > 0) {
    memory.serviceHistory = recentAppointments.map(apt => ({
      serviceType: apt.service_type,
      date: apt.start_time,
      status: apt.status
    }));
    memory.previousServices = recentAppointments.map(apt => apt.service_type);
    memory.lastServiceDate = recentAppointments[0].start_time;
    memory.favoriteService = findMostFrequentService(recentAppointments);
  }
  
  if (pendingAppointments && pendingAppointments.length > 0) {
    memory.currentBookingStatus = pendingAppointments[0].status;
    memory.pendingAppointmentDetails = {
      serviceType: pendingAppointments[0].service_type,
      date: pendingAppointments[0].start_time,
      location: pendingAppointments[0].location_description,
      specificAddress: pendingAppointments[0].specific_address,
      notes: pendingAppointments[0].notes,
      durationMinutes: pendingAppointments[0].duration_minutes
    };
  }
  
  // Analyze communication patterns from messages
  if (messages && messages.length > 0) {
    const messageCount = messages.length;
    const avgMessageLength = messages.reduce((sum, msg) => sum + (msg.content ? msg.content.length : 0), 0) / messageCount;
    
    memory.communicationHistory = {
      totalMessages: messageCount,
      averageMessageLength: Math.round(avgMessageLength),
      respondsWellTo: avgMessageLength > 100 ? 'detailed explanations' : 'concise answers',
      preferredPace: messageCount > 10 ? 'detailed discussion' : 'quick decisions',
      lastMessageDate: messages[messages.length - 1]?.created_at,
      conversationStarter: messages[0]?.content || '',
      recentTopics: extractRecentTopics(messages.slice(-5)) // Last 5 messages
    };
  } else {
    memory.communicationHistory = {
      totalMessages: 0,
      averageMessageLength: 0,
      respondsWellTo: 'concise answers',
      preferredPace: 'quick decisions'
    };
  }
  
  return memory;
}

// Helper function to find most frequent service
function findMostFrequentService(appointments) {
  if (!appointments || appointments.length === 0) return null;
  
  const serviceCounts = {};
  appointments.forEach(apt => {
    if (apt.service_type) {
      serviceCounts[apt.service_type] = (serviceCounts[apt.service_type] || 0) + 1;
    }
  });
  
  return Object.keys(serviceCounts).reduce((a, b) => 
    serviceCounts[a] > serviceCounts[b] ? a : b
  );
}

// Helper function to extract recent conversation topics
function extractRecentTopics(recentMessages) {
  if (!recentMessages || recentMessages.length === 0) return [];
  
  const topics = [];
  const recentText = recentMessages.map(msg => msg.content).join(' ').toLowerCase();
  
  const topicKeywords = {
    pricing: ['price', 'cost', 'fee', 'budget', '$'],
    services: ['minimalistic', 'soft party', 'bridal', 'glam'],
    scheduling: ['time', 'date', 'available', 'schedule'],
    location: ['address', 'location', 'travel', 'where'],
    skin: ['skin', 'allergies', 'tone', 'type']
  };
  
  Object.keys(topicKeywords).forEach(topic => {
    if (topicKeywords[topic].some(keyword => recentText.includes(keyword))) {
      topics.push(topic);
    }
  });
  
  return topics;
}

router.post('/store-pending-rescheduling', async (req, res) => {
  const { 
    clientPhone, 
    clientName = "New Client", 
    serviceType = "Makeup Service", 
    location = "Client's Location", 
    specificAddress,
    newStartDateTime, 
    duration = 60, 
    notes = '', 
    skinType,
    skinTone,
    allergies,
    reason = '' // Reason for rescheduling
  } = req.body;
  
  if (!clientPhone || !newStartDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'Client phone and new start date-time are required for rescheduling' 
    });
  }
  
  try {
    // Format phone number
    let formattedPhone = clientPhone;
    const digits = formattedPhone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    }
    
    // Find existing pending or confirmed appointment to reschedule
    const { data: existingAppointments, error: findError } = await supabase
      .from('appointments')
      .select('*')
      .eq('client_phone', formattedPhone)
      .in('status', ['pending_confirmation', 'pending', 'confirmed'])
      .gte('start_time', new Date().toISOString()) // Only future appointments
      .order('start_time', { ascending: true })
      .limit(1);
    
    if (findError) {
      console.error('Error finding existing appointment:', findError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to find existing appointment: ' + findError.message 
      });
    }
    
    if (!existingAppointments || existingAppointments.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'No existing appointment found to reschedule' 
      });
    }
    
    const existingAppointment = existingAppointments[0];
    console.log('Found existing appointment to reschedule:', existingAppointment.id);
    
    // Get or update client info
    let client = await clientOps.getByPhoneNumber(formattedPhone);
    
    if (!client) {
      console.log(`Creating new client: ${clientName} (${formattedPhone})`);
      client = await clientOps.createOrUpdate({ 
        phone_number: formattedPhone, 
        name: clientName,
        skin_type: skinType,
        skin_tone: skinTone,
        allergies: allergies,
        status: 'Needs Confirmation'
      });
    } else {
      // Update client status to 'Needs Confirmation' for rescheduling
      const updateFields = { status: 'Needs Confirmation', updated_at: new Date().toISOString() };
      if (clientName && clientName !== client.name) updateFields.name = clientName;
      if (skinType && skinType !== client.skin_type) updateFields.skin_type = skinType;
      if (skinTone && skinTone !== client.skin_tone) updateFields.skin_tone = skinTone;
      if (allergies && allergies !== client.allergies) updateFields.allergies = allergies;
      
      const { data, error } = await supabase
        .from('clients')
        .update(updateFields)
        .eq('phone_number', formattedPhone)
        .select();
        
      if (!error && data[0]) {
        client = data[0];
      }
    }
    
    // Calculate new end time in Central Time
    const newEndDateTime = calculateEndTime(newStartDateTime, duration);
    
    // Store times in Central Time format for database
    const startTimeForDB = convertCTtoUTC(newStartDateTime);
    const endTimeForDB = convertCTtoUTC(newEndDateTime);
    
    console.log(`Rescheduling appointment ${existingAppointment.id}:`);
    console.log(`Old time: ${existingAppointment.start_time} -> New time: ${startTimeForDB}`);
    
    // If existing appointment has Google Calendar event, we need to handle it
    let cancelOldEvent = false;
    if (existingAppointment.google_calendar_event_id && existingAppointment.status === 'confirmed') {
      cancelOldEvent = true;
    }
    
    // Update the existing appointment with new details
    const rescheduleNotes = [
      existingAppointment.notes || '',
      `\n--- RESCHEDULED on ${new Date().toLocaleDateString()} ---`,
      `Original time: ${convertUTCtoCT(existingAppointment.start_time)}`,
      `New time: ${newStartDateTime}`,
      reason ? `Reason: ${reason}` : '',
      notes ? `New notes: ${notes}` : ''
    ].filter(Boolean).join('\n').trim();
    
    const updateData = {
      service_type: serviceType || existingAppointment.service_type,
      location_description: location || existingAppointment.location_description,
      specific_address: specificAddress || existingAppointment.specific_address,
      start_time: startTimeForDB,
      end_time: endTimeForDB,
      duration_minutes: duration,
      status: 'pending_confirmation', // Reset to pending for artist confirmation
      notes: rescheduleNotes,
      google_calendar_event_id: null, // Will be set when confirmed
      updated_at: new Date().toISOString()
    };
    
    const { data: updatedAppointment, error: updateError } = await supabase
      .from('appointments')
      .update(updateData)
      .eq('id', existingAppointment.id)
      .select();
    
    if (updateError) {
      console.error('Error updating appointment for rescheduling:', updateError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to reschedule appointment: ' + updateError.message 
      });
    }
    
    // Cancel old Google Calendar event if it exists
    if (cancelOldEvent) {
      try {
        // Get artist's calendar credentials
        const { data: artist, error: artistError } = await supabase
          .from('makeup_artists')
          .select('*')
          .single();
        
        if (artist?.refresh_token) {
          const oauth2Client = createOAuth2Client(artist.refresh_token);
          const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
          const calendarId = artist.selected_calendar_id || 'primary';
          
          await calendar.events.delete({
            calendarId,
            eventId: existingAppointment.google_calendar_event_id,
            sendUpdates: 'all'
          });
          
          console.log('Old Google Calendar event cancelled successfully');
        }
      } catch (calendarError) {
        console.error('Warning: Could not cancel old calendar event:', calendarError);
        // Don't fail the whole operation if calendar cleanup fails
      }
    }
    
    console.log('Appointment rescheduled successfully:', updatedAppointment[0].id);
    
    return res.status(200).json({
      success: true,
      action: 'reschedule',
      appointmentId: updatedAppointment[0].id,
      appointment: updatedAppointment[0],
      client: client,
      message: 'Appointment rescheduled successfully. Awaiting artist confirmation.',
      originalTime: {
        start: convertUTCtoCT(existingAppointment.start_time),
        end: convertUTCtoCT(existingAppointment.end_time)
      },
      newTime: {
        start: newStartDateTime,
        end: newEndDateTime,
        timezone: 'America/Chicago'
      },
      oldCalendarEventCancelled: cancelOldEvent
    });
  } catch (e) {
    console.error('Error in store-pending-rescheduling:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// =============================================================================
// CALENDAR MANAGEMENT ENDPOINTS - Add these to your webhook.js file
// =============================================================================

// 1. Block Calendar Period
router.post('/block-calendar-period', async (req, res) => {
  const { 
    startDateTime, 
    endDateTime, 
    blockType = 'unavailable', 
    reason = 'Blocked time', 
    allDay = false 
  } = req.body;
  
  console.log('Block calendar period request:', JSON.stringify(req.body, null, 2));
  
  // Validate required fields
  if (!startDateTime || !endDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'Start and end date-time are required for blocking calendar' 
    });
  }
  
  try {
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
    
    // Format block type for display
    const blockTypeDisplay = blockType.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
    
    // Create event details for calendar block
    const eventDetails = {
      summary: `🚫 BLOCKED - ${blockTypeDisplay}`,
      description: `Calendar blocked for: ${reason}\nBlock Type: ${blockTypeDisplay}\nCreated: ${new Date().toISOString()}`,
      start: allDay ? 
        { date: startDateTime.split('T')[0], timeZone: 'America/Chicago' } :
        { dateTime: startDateTime, timeZone: 'America/Chicago' },
      end: allDay ? 
        { date: endDateTime.split('T')[0], timeZone: 'America/Chicago' } :
        { dateTime: endDateTime, timeZone: 'America/Chicago' },
      status: 'confirmed',
      transparency: 'opaque', // Shows as busy
      visibility: 'private'
    };
    
    console.log('Creating calendar block with details:', JSON.stringify(eventDetails, null, 2));
    
    try {
      // Create the calendar block event
      const event = await calendar.events.insert({ 
        calendarId, 
        resource: eventDetails 
      });
      
      console.log('Calendar block created successfully:', event.data.id);
      
      // Store the calendar block in database for tracking
      const blockData = {
        google_calendar_event_id: event.data.id,
        block_type: blockType,
        reason: reason,
        start_time: convertCTtoUTC(startDateTime),
        end_time: convertCTtoUTC(endDateTime),
        all_day: allDay,
        status: 'active'
      };
      
      // Create calendar_blocks table entry
      const { data: blockRecord, error: blockError } = await supabase
        .from('calendar_blocks')
        .insert(blockData)
        .select();
      
      if (blockError) {
        console.error('Error storing calendar block:', blockError);
        // Don't fail the whole operation if database storage fails
      }
      
      // Calculate duration for response
      const startDate = new Date(startDateTime);
      const endDate = new Date(endDateTime);
      const durationHours = Math.round((endDate - startDate) / (1000 * 60 * 60));
      const durationDays = Math.round(durationHours / 24);
      
      return res.status(200).json({
        success: true,
        action: 'block_calendar',
        eventId: event.data.id,
        eventLink: event.data.htmlLink,
        blockRecord: blockRecord ? blockRecord[0] : null,
        message: 'Calendar period blocked successfully',
        blockDetails: {
          type: blockTypeDisplay,
          reason: reason,
          start: startDateTime,
          end: endDateTime,
          allDay: allDay,
          duration: {
            hours: durationHours,
            days: durationDays
          }
        }
      });
    } catch (calendarError) {
      console.error('Google Calendar error:', calendarError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to block calendar period: ' + calendarError.message 
      });
    }
  } catch (e) {
    console.error('Error in block-calendar-period endpoint:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// 2. Get Calendar Information
router.get('/get-calendar-info', async (req, res) => {
  const { 
    startDate, 
    endDate, 
    includeBlocks = true, 
    includeAvailability = false 
  } = req.query;
  
  console.log('Get calendar info request:', JSON.stringify(req.query, null, 2));
  
  // Validate required fields
  if (!startDate || !endDate) {
    return res.status(400).json({ 
      success: false, 
      error: 'Start and end dates are required' 
    });
  }
  
  try {
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
      // Get all events in the specified period
      const response = await calendar.events.list({
        calendarId,
        timeMin: new Date(startDate).toISOString(),
        timeMax: new Date(endDate).toISOString(),
        timeZone: 'America/Chicago',
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250
      });
      
      const events = response.data.items || [];
      
      // Separate appointments from blocks
      const appointments = [];
      const blocks = [];
      
      events.forEach(event => {
        const eventData = {
          id: event.id,
          summary: event.summary || 'Untitled',
          start: event.start?.dateTime || event.start?.date,
          end: event.end?.dateTime || event.end?.date,
          location: event.location,
          description: event.description,
          status: event.status
        };
        
        // Check if it's a calendar block (starts with blocked indicator)
        if (event.summary && event.summary.includes('BLOCKED')) {
          blocks.push({
            ...eventData,
            blockType: extractBlockType(event.summary, event.description),
            reason: extractBlockReason(event.description)
          });
        } else {
          // It's a regular appointment
          appointments.push(eventData);
        }
      });
      
      // Get appointments from database for additional context
      const { data: dbAppointments, error: dbError } = await supabase
        .from('appointments')
        .select(`
          *,
          client:clients!appointments_client_phone_fkey(name, phone_number)
        `)
        .gte('start_time', startDate)
        .lte('start_time', endDate)
        .order('start_time', { ascending: true });
      
      // Enrich appointments with database info
      const enrichedAppointments = appointments.map(gcalEvent => {
        const dbMatch = dbAppointments?.find(dbApt => 
          dbApt.google_calendar_event_id === gcalEvent.id
        );
        
        if (dbMatch) {
          return {
            ...gcalEvent,
            clientName: dbMatch.client?.name || 'Unknown Client',
            clientPhone: dbMatch.client?.phone_number,
            serviceType: dbMatch.service_type,
            appointmentStatus: dbMatch.status,
            locationDescription: dbMatch.location_description,
            specificAddress: dbMatch.specific_address,
            duration: dbMatch.duration_minutes,
            notes: dbMatch.notes
          };
        }
        
        return gcalEvent;
      });
      
      // Calculate availability windows if requested
      let availabilityWindows = [];
      if (includeAvailability === 'true') {
        availabilityWindows = calculateAvailabilityWindows(
          new Date(startDate), 
          new Date(endDate), 
          events
        );
      }
      
      return res.status(200).json({
        success: true,
        period: {
          start: startDate,
          end: endDate
        },
        appointments: enrichedAppointments,
        blocks: includeBlocks === 'true' ? blocks : [],
        availabilityWindows: availabilityWindows,
        summary: {
          totalAppointments: enrichedAppointments.length,
          totalBlocks: blocks.length,
          totalEvents: events.length,
          availableHours: availabilityWindows.reduce((sum, window) => 
            sum + (window.durationHours || 0), 0)
        }
      });
    } catch (calendarError) {
      console.error('Google Calendar error:', calendarError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to retrieve calendar information: ' + calendarError.message 
      });
    }
  } catch (e) {
    console.error('Error in get-calendar-info endpoint:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// 3. Get Calendar Blocks
router.get('/get-calendar-blocks', async (req, res) => {
  const { startDate, endDate, blockType } = req.query;
  
  try {
    let query = supabase
      .from('calendar_blocks')
      .select('*')
      .eq('status', 'active')
      .order('start_time', { ascending: true });
    
    if (startDate) {
      query = query.gte('start_time', startDate);
    }
    
    if (endDate) {
      query = query.lte('end_time', endDate);
    }
    
    if (blockType) {
      query = query.eq('block_type', blockType);
    }
    
    const { data, error } = await query;
    
    if (error) {
      throw error;
    }
    
    // Format blocks for response
    const formattedBlocks = (data || []).map(block => ({
      id: block.id,
      eventId: block.google_calendar_event_id,
      type: block.block_type,
      reason: block.reason,
      start: convertUTCtoCT(block.start_time),
      end: convertUTCtoCT(block.end_time),
      allDay: block.all_day,
      duration: calculateBlockDuration(block.start_time, block.end_time),
      created: block.created_at
    }));
    
    return res.status(200).json({
      success: true,
      blocks: formattedBlocks,
      count: formattedBlocks.length,
      summary: {
        totalBlocks: formattedBlocks.length,
        blockTypes: [...new Set(formattedBlocks.map(b => b.type))],
        totalHoursBlocked: formattedBlocks.reduce((sum, block) => 
          sum + (block.duration?.hours || 0), 0)
      }
    });
  } catch (e) {
    console.error('Error in get-calendar-blocks:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// 4. Remove Calendar Block
router.post('/remove-calendar-block', async (req, res) => {
  const { eventId, blockId } = req.body;
  
  if (!eventId && !blockId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Event ID or Block ID is required' 
    });
  }
  
  try {
    // Get the block record
    let blockRecord;
    if (blockId) {
      const { data, error } = await supabase
        .from('calendar_blocks')
        .select('*')
        .eq('id', blockId)
        .single();
      
      if (error || !data) {
        return res.status(404).json({ 
          success: false, 
          error: 'Calendar block not found' 
        });
      }
      blockRecord = data;
    } else {
      const { data, error } = await supabase
        .from('calendar_blocks')
        .select('*')
        .eq('google_calendar_event_id', eventId)
        .single();
      
      if (error || !data) {
        return res.status(404).json({ 
          success: false, 
          error: 'Calendar block not found' 
        });
      }
      blockRecord = data;
    }
    
    // Get artist's calendar credentials
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
    
    try {
      // Delete from Google Calendar
      await calendar.events.delete({
        calendarId,
        eventId: blockRecord.google_calendar_event_id
      });
      
      console.log('Calendar block deleted from Google Calendar');
      
      // Update block status in database
      const { data, error } = await supabase
        .from('calendar_blocks')
        .update({ 
          status: 'deleted', 
          updated_at: new Date().toISOString() 
        })
        .eq('id', blockRecord.id)
        .select();
      
      if (error) {
        console.error('Error updating block status:', error);
        return res.status(500).json({ 
          success: false, 
          error: 'Block removed from calendar but failed to update database: ' + error.message 
        });
      }
      
      return res.status(200).json({
        success: true,
        action: 'remove_block',
        eventId: blockRecord.google_calendar_event_id,
        blockId: blockRecord.id,
        message: 'Calendar block removed successfully',
        removedBlock: {
          type: blockRecord.block_type,
          reason: blockRecord.reason,
          period: {
            start: convertUTCtoCT(blockRecord.start_time),
            end: convertUTCtoCT(blockRecord.end_time)
          }
        }
      });
    } catch (calendarError) {
      console.error('Google Calendar error:', calendarError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to remove calendar block: ' + calendarError.message 
      });
    }
  } catch (e) {
    console.error('Error in remove-calendar-block endpoint:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// 5. Get Availability Windows
router.get('/get-availability-windows', async (req, res) => {
  const { 
    startDate, 
    endDate, 
    minDuration = 60, 
    businessHoursOnly = true 
  } = req.query;
  
  if (!startDate || !endDate) {
    return res.status(400).json({ 
      success: false, 
      error: 'Start and end dates are required' 
    });
  }
  
  try {
    // Get artist's calendar credentials
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
    
    try {
      // Get all events (appointments and blocks) in the period
      const response = await calendar.events.list({
        calendarId,
        timeMin: new Date(startDate).toISOString(),
        timeMax: new Date(endDate).toISOString(),
        timeZone: 'America/Chicago',
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250
      });
      
      const events = response.data.items || [];
      
      // Calculate availability windows
      const availabilityWindows = calculateDetailedAvailability(
        new Date(startDate),
        new Date(endDate),
        events,
        parseInt(minDuration),
        businessHoursOnly === 'true'
      );
      
      return res.status(200).json({
        success: true,
        period: {
          start: startDate,
          end: endDate
        },
        availabilityWindows,
        summary: {
          totalWindows: availabilityWindows.length,
          totalAvailableHours: availabilityWindows.reduce((sum, window) => 
            sum + window.durationHours, 0),
          longestWindow: availabilityWindows.reduce((max, window) => 
            window.durationHours > (max?.durationHours || 0) ? window : max, null)
        },
        filters: {
          minDuration: parseInt(minDuration),
          businessHoursOnly: businessHoursOnly === 'true'
        }
      });
    } catch (calendarError) {
      console.error('Google Calendar error:', calendarError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to calculate availability: ' + calendarError.message 
      });
    }
  } catch (e) {
    console.error('Error in get-availability-windows endpoint:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =============================================================================
// HELPER FUNCTIONS FOR CALENDAR OPERATIONS
// =============================================================================

// Extract block type from calendar event
function extractBlockType(summary, description) {
  const summaryLower = summary.toLowerCase();
  
  if (summaryLower.includes('vacation')) return 'vacation';
  if (summaryLower.includes('personal')) return 'personal';
  if (summaryLower.includes('maintenance')) return 'maintenance';
  if (summaryLower.includes('travel')) return 'travel';
  if (summaryLower.includes('sick')) return 'sick';
  
  // Check description for block type
  if (description) {
    const descLower = description.toLowerCase();
    if (descLower.includes('block type: vacation')) return 'vacation';
    if (descLower.includes('block type: personal')) return 'personal';
    if (descLower.includes('block type: maintenance')) return 'maintenance';
    if (descLower.includes('block type: travel')) return 'travel';
    if (descLower.includes('block type: sick')) return 'sick';
  }
  
  return 'unavailable'; // Default
}

// Extract block reason from description
function extractBlockReason(description) {
  if (!description) return 'No reason specified';
  
  const reasonMatch = description.match(/Calendar blocked for: ([^\n]+)/);
  if (reasonMatch) {
    return reasonMatch[1];
  }
  
  return description.split('\n')[0] || 'No reason specified';
}

// Calculate duration of a calendar block
function calculateBlockDuration(startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const durationMs = end - start;
  
  const hours = Math.round(durationMs / (1000 * 60 * 60) * 10) / 10;
  const days = Math.round(hours / 24 * 10) / 10;
  
  return {
    hours,
    days,
    formatted: hours < 24 ? `${hours} hours` : `${days} days`
  };
}

// Calculate basic availability windows
function calculateAvailabilityWindows(startDate, endDate, events) {
  const windows = [];
  const businessStart = 9; // 9 AM
  const businessEnd = 18; // 6 PM
  
  // Sort events by start time
  const sortedEvents = events
    .filter(event => event.start?.dateTime || event.start?.date)
    .sort((a, b) => {
      const aStart = new Date(a.start.dateTime || a.start.date);
      const bStart = new Date(b.start.dateTime || b.start.date);
      return aStart - bStart;
    });
  
  let currentDate = new Date(startDate);
  const endDateObj = new Date(endDate);
  
  while (currentDate <= endDateObj) {
    // Skip weekends (optional - remove if MUA works weekends)
    const dayOfWeek = currentDate.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    // Get events for this day
    const dayEvents = sortedEvents.filter(event => {
      const eventStart = new Date(event.start.dateTime || event.start.date);
      return eventStart.toDateString() === currentDate.toDateString();
    });
    
    // Calculate availability for this day
    let dayStart = new Date(currentDate);
    dayStart.setHours(businessStart, 0, 0, 0);
    
    const dayEnd = new Date(currentDate);
    dayEnd.setHours(businessEnd, 0, 0, 0);
    
    let currentTime = new Date(dayStart);
    
    for (const event of dayEvents) {
      const eventStart = new Date(event.start.dateTime || event.start.date);
      const eventEnd = new Date(event.end.dateTime || event.end.date);
      
      // If there's a gap before this event
      if (currentTime < eventStart) {
        const availableEnd = eventStart < dayEnd ? eventStart : dayEnd;
        const durationMs = availableEnd - currentTime;
        const durationHours = durationMs / (1000 * 60 * 60);
        
        if (durationHours >= 1) { // At least 1 hour window
          windows.push({
            start: currentTime.toISOString(),
            end: availableEnd.toISOString(),
            durationHours: Math.round(durationHours * 2) / 2,
            date: currentDate.toDateString()
          });
        }
      }
      
      // Move current time to after this event
      currentTime = new Date(Math.max(currentTime, eventEnd));
    }
    
    // Check for availability after last event
    if (currentTime < dayEnd) {
      const durationMs = dayEnd - currentTime;
      const durationHours = durationMs / (1000 * 60 * 60);
      
      if (durationHours >= 1) {
        windows.push({
          start: currentTime.toISOString(),
          end: dayEnd.toISOString(),
          durationHours: Math.round(durationHours * 2) / 2,
          date: currentDate.toDateString()
        });
      }
    }
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return windows;
}

// Calculate detailed availability with more options
function calculateDetailedAvailability(startDate, endDate, events, minDuration, businessHoursOnly) {
  const windows = [];
  const businessStart = businessHoursOnly ? 9 : 0;
  const businessEnd = businessHoursOnly ? 18 : 24;
  
  // Sort events by start time
  const sortedEvents = events
    .filter(event => event.start?.dateTime || event.start?.date)
    .sort((a, b) => {
      const aStart = new Date(a.start.dateTime || a.start.date);
      const bStart = new Date(b.start.dateTime || b.start.date);
      return aStart - bStart;
    });
  
  let currentDate = new Date(startDate);
  const endDateObj = new Date(endDate);
  
  while (currentDate <= endDateObj) {
    // Skip weekends if business hours only
    const dayOfWeek = currentDate.getDay();
    if (businessHoursOnly && (dayOfWeek === 0 || dayOfWeek === 6)) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    // Get events for this day
    const dayEvents = sortedEvents.filter(event => {
      const eventStart = new Date(event.start.dateTime || event.start.date);
      return eventStart.toDateString() === currentDate.toDateString();
    });
    
    // Calculate availability for this day
    let dayStart = new Date(currentDate);
    dayStart.setHours(businessStart, 0, 0, 0);
    
    const dayEnd = new Date(currentDate);
    dayEnd.setHours(businessEnd, 0, 0, 0);
    
    let currentTime = new Date(dayStart);
    
    for (const event of dayEvents) {
      const eventStart = new Date(event.start.dateTime || event.start.date);
      const eventEnd = new Date(event.end.dateTime || event.end.date);
      
      // If there's a gap before this event
      if (currentTime < eventStart) {
        const availableEnd = eventStart < dayEnd ? eventStart : dayEnd;
        const durationMs = availableEnd - currentTime;
        const durationMinutes = durationMs / (1000 * 60);
        const durationHours = durationMinutes / 60;
        
        if (durationMinutes >= minDuration) {
          windows.push({
            start: currentTime.toISOString(),
            end: availableEnd.toISOString(),
            durationMinutes: Math.floor(durationMinutes),
            durationHours: Math.round(durationHours * 2) / 2,
            date: currentDate.toDateString(),
            dayOfWeek: currentDate.toLocaleDateString('en-US', { weekday: 'long' }),
            timeSlot: formatTimeSlot(currentTime, availableEnd)
          });
        }
      }
      
      // Move current time to after this event
      currentTime = new Date(Math.max(currentTime, eventEnd));
    }
    
    // Check for availability after last event
    if (currentTime < dayEnd) {
      const durationMs = dayEnd - currentTime;
      const durationMinutes = durationMs / (1000 * 60);
      const durationHours = durationMinutes / 60;
      
      if (durationMinutes >= minDuration) {
        windows.push({
          start: currentTime.toISOString(),
          end: dayEnd.toISOString(),
          durationMinutes: Math.floor(durationMinutes),
          durationHours: Math.round(durationHours * 2) / 2,
          date: currentDate.toDateString(),
          dayOfWeek: currentDate.toLocaleDateString('en-US', { weekday: 'long' }),
          timeSlot: formatTimeSlot(currentTime, dayEnd)
        });
      }
    }
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return windows;
}

// Format time slot for display
function formatTimeSlot(start, end) {
  const formatTime = (date) => {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Chicago'
    });
  };
  
  return `${formatTime(start)} - ${formatTime(end)}`;
}

module.exports = router;

// Export helper functions for testing
module.exports.convertCTtoUTC = convertCTtoUTC;
module.exports.convertUTCtoCT = convertUTCtoCT;