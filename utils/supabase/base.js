const { createClient } = require('@supabase/supabase-js');

/**
 * Creates a Supabase client with the provided credentials
 * @param {string} url - The Supabase URL
 * @param {string} key - The Supabase API key
 * @returns {Object} - The Supabase client instance
 */
function createSupabaseClient(url, key) {
  if (!url || !key) {
    throw new Error('Missing Supabase credentials');
  }
  
  return createClient(url, key);
}

/**
 * Creates a standard set of database operations for a client
 * @param {Object} supabase - The Supabase client instance
 * @returns {Object} - Object containing all database operations
 */
function createClientOperations(supabase) {
  // BarberOps - Operations related to barbers
  const barberOps = {
    async getByPhoneNumber(phoneNumber) {
      const { data, error } = await supabase
        .from('barbers')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();
        
      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching barber:', error);
      }
      return data;
    },
    
    async updateOrCreate(barberData) {
      const { phone_number, name, email, refresh_token, selected_calendar_id } = barberData;
      
      // Check if barber exists
      const existingBarber = await this.getByPhoneNumber(phone_number);
      
      if (existingBarber) {
        // Update existing barber
        const { data, error } = await supabase
          .from('barbers')
          .update({
            name: name || existingBarber.name,
            email: email || existingBarber.email,
            refresh_token: refresh_token || existingBarber.refresh_token,
            selected_calendar_id: selected_calendar_id || existingBarber.selected_calendar_id,
            updated_at: new Date()
          })
          .eq('phone_number', phone_number)
          .select();
          
        if (error) {
          console.error('Error updating barber:', error);
          return null;
        }
        
        return data[0];
      } else {
        // Create new barber
        const { data, error } = await supabase
          .from('barbers')
          .insert({
            phone_number,
            name: name || 'New Barber',
            email,
            refresh_token,
            selected_calendar_id: selected_calendar_id || 'primary'
          })
          .select();
          
        if (error) {
          console.error('Error creating barber:', error);
          return null;
        }
        
        return data[0];
      }
    },
    
    async updateCalendarId(phoneNumber, calendarId) {
      const { data, error } = await supabase
        .from('barbers')
        .update({
          selected_calendar_id: calendarId,
          updated_at: new Date()
        })
        .eq('phone_number', phoneNumber)
        .select();
        
      if (error) {
        console.error('Error updating calendar ID:', error);
        return null;
      }
      
      return data[0];
    },

    async getAllBarbers() {
      const { data, error } = await supabase
        .from('barbers')
        .select('id, name')
        .order('name', { ascending: true });
        
      if (error) {
        console.error('Error fetching all barbers:', error);
        return [];
      }
      
      return data;
    },
    
    async getFirstWithRefreshToken() {
      const { data, error } = await supabase
        .from('barbers')
        .select('*')
        .not('refresh_token', 'is', null)
        .limit(1);
        
      if (error) {
        console.error('Error fetching barber with refresh token:', error);
        return { data: null, error };
      }
      
      return { data: data[0], error: null };
    },
    
    async getById(barberId) {
      const { data, error } = await supabase
        .from('barbers')
        .select('*')
        .eq('id', barberId)
        .single();
        
      if (error) {
        console.error('Error fetching barber by ID:', error);
        return null;
      }
      
      return data;
    }
  };

  // ClientOps - Operations related to clients
  const clientOps = {
    async getByPhoneNumber(phoneNumber) {
      const { data, error } = await supabase
        .from('clients')
        .select(`
          *,
          preferred_barber:barbers(id, name, phone_number)
        `)
        .eq('phone_number', phoneNumber)
        .single();
        
      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching client:', error);
      }
      return data;
    },
    
    async getByPlatformIdentifier(identifier, platform) {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .eq('identifier', identifier)
        .eq('platform', platform)
        .single();
        
      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching client by platform identifier:', error);
      }
      return data;
    },

    async updatePreferredBarber(clientPhone, preferredBarberId) {
      const { data, error } = await supabase
        .from('clients')
        .update({
          preferred_barber_id: preferredBarberId,
          updated_at: new Date()
        })
        .eq('phone_number', clientPhone)
        .select();
        
      if (error) {
        console.error('Error updating client preferred barber:', error);
        return null;
      }
      
      return data[0];
    },

    async createOrUpdate(clientData) {
      const { 
        phone_number, 
        name, 
        email, 
        preferred_barber_id,
        identifier,
        platform 
      } = clientData;
      
      let existingClient = null;
      
      // Check if client exists by phone number if provided
      if (phone_number) {
        existingClient = await this.getByPhoneNumber(phone_number);
      } 
      // Or check by platform identifier if provided
      else if (identifier && platform) {
        existingClient = await this.getByPlatformIdentifier(identifier, platform);
      }
      
      if (existingClient) {
        // Update existing client
        const updateData = {
          updated_at: new Date()
        };
        
        // Only add fields that are provided
        if (name) updateData.name = name;
        if (email) updateData.email = email;
        if (preferred_barber_id) updateData.preferred_barber_id = preferred_barber_id;
        if (phone_number) updateData.phone_number = phone_number;
        if (identifier) updateData.identifier = identifier;
        if (platform) updateData.platform = platform;
        
        const { data, error } = await supabase
          .from('clients')
          .update(updateData)
          .eq('id', existingClient.id)
          .select();
          
        if (error) {
          console.error('Error updating client:', error);
          return null;
        }
        
        return data[0];
      } else {
        // Create new client
        const insertData = {
          name: name || 'New Client'
        };
        
        // Only add fields that are provided
        if (email) insertData.email = email;
        if (preferred_barber_id) insertData.preferred_barber_id = preferred_barber_id;
        if (phone_number) insertData.phone_number = phone_number;
        if (identifier) insertData.identifier = identifier;
        if (platform) insertData.platform = platform;
        
        const { data, error } = await supabase
          .from('clients')
          .insert(insertData)
          .select();
          
        if (error) {
          console.error('Error creating client:', error);
          return null;
        }
        
        return data[0];
      }
    }
  };

  // AppointmentOps - Operations related to appointments
  const appointmentOps = {
    async create(appointmentData) {
      const { 
        client_phone, 
        client_identifier,
        platform,
        barber_id, 
        service_type, 
        start_time, 
        end_time, 
        google_calendar_event_id,
        notes,
        client_name
      } = appointmentData;
      
      const insertData = {
        service_type,
        start_time,
        end_time,
        google_calendar_event_id,
        barber_id
      };
      
      // Add optional fields if provided
      if (client_phone) insertData.client_phone = client_phone;
      if (client_identifier) insertData.client_identifier = client_identifier;
      if (platform) insertData.platform = platform;
      if (notes) insertData.notes = notes;
      if (client_name) insertData.client_name = client_name;
      
      const { data, error } = await supabase
        .from('appointments')
        .insert(insertData)
        .select();
        
      if (error) {
        console.error('Error creating appointment:', error);
        return null;
      }
      
      return data[0];
    },
    
    async updateByEventId(eventId, updateData) {
      console.log(`Attempting to update appointment with event ID: ${eventId}`);
      console.log('Update data:', updateData);
      
      const { data, error } = await supabase
        .from('appointments')
        .update({
          ...updateData,
          updated_at: new Date()
        })
        .eq('google_calendar_event_id', eventId)
        .select();
        
      if (error) {
        console.error('Error updating appointment:', error);
        return { success: false, error };
      }
      
      if (data && data.length === 0) {
        console.warn(`No appointment found with event ID: ${eventId}`);
        return { success: false, message: 'No matching appointment found' };
      }
      
      console.log('Successfully updated appointment:', data);
      return { success: true, data: data[0] };
    },
    
    async cancelAppointment(eventId) {
      const { data, error } = await supabase
        .from('appointments')
        .delete()
        .eq('google_calendar_event_id', eventId);
        
      if (error) {
        console.error('Error cancelling appointment:', error);
        return false;
      }
      
      return true;
    },
    
    async findByClientPhone(clientPhone, startTimeRange) {
      let query = supabase
        .from('appointments')
        .select('*')
        .eq('client_phone', clientPhone);
      
      // If start time range is provided, filter by that too
      if (startTimeRange) {
        const { startBefore, startAfter } = startTimeRange;
        
        if (startBefore) {
          query = query.lt('start_time', startBefore);
        }
        
        if (startAfter) {
          query = query.gt('start_time', startAfter);
        }
      }
      
      const { data, error } = await query;
      
      if (error) {
        console.error('Error finding appointments by phone:', error);
        return [];
      }
      
      return data;
    },
    
    async findByClientIdentifier(identifier, platform, timeRange) {
      let query = supabase
        .from('appointments')
        .select('*')
        .eq('client_identifier', identifier)
        .eq('platform', platform);
      
      // If time range is provided, filter by that too
      if (timeRange) {
        const { startBefore, startAfter } = timeRange;
        
        if (startBefore) {
          query = query.lt('start_time', startBefore);
        }
        
        if (startAfter) {
          query = query.gt('start_time', startAfter);
        }
      }
      
      const { data, error } = await query.order('start_time', { ascending: false });
      
      if (error) {
        console.error('Error finding appointments by identifier:', error);
        return [];
      }
      
      return data;
    }
  };

  // BookingStateOps - Operations related to booking state
  const bookingStateOps = {
    async updateBookingState(clientIdentifier, stateData) {
      // Handle both phone and platform identifier
      let clientField, clientValue;
      
      if (clientIdentifier.phone) {
        clientField = 'phone_number';
        clientValue = clientIdentifier.phone;
      } else if (clientIdentifier.identifier && clientIdentifier.platform) {
        clientField = 'identifier';
        clientValue = clientIdentifier.identifier;
        // Will need platform too
        platform = clientIdentifier.platform;
      } else {
        console.error('Missing required client identifier');
        return null;
      }
      
      const { status, appointmentDetails = null } = stateData;
      
      if (!status) {
        console.error('Missing required status for updating booking state');
        return null;
      }
      
      // Get client based on identifier type
      let existingClient;
      if (clientField === 'phone_number') {
        existingClient = await clientOps.getByPhoneNumber(clientValue);
      } else {
        // Additional query for platform identifier
        const { data, error } = await supabase
          .from('clients')
          .select('*')
          .eq('identifier', clientValue)
          .eq('platform', platform)
          .single();
          
        if (error) {
          console.error('Error finding client by platform identifier:', error);
          return null;
        }
        existingClient = data;
      }
      
      if (!existingClient) {
        console.error(`Client with ${clientField} ${clientValue} not found`);
        return null;
      }
      
      // Get current booking state
      const currentState = existingClient.last_booking_state || {
        status: 'not_started',
        appointmentDetails: null,
        lastUpdated: null
      };
      
      // Prepare updated state
      const updatedState = {
        status,
        appointmentDetails: appointmentDetails || currentState.appointmentDetails,
        lastUpdated: new Date().toISOString()
      };
      
      // Update client record
      const { data, error } = await supabase
        .from('clients')
        .update({ 
          last_booking_state: updatedState,
          updated_at: new Date()
        })
        .eq('id', existingClient.id)
        .select();
        
      if (error) {
        console.error('Error updating booking state:', error);
        return null;
      }
      
      return data[0];
    },
    
    async getBookingState(clientIdentifier) {
      // Handle both phone and platform identifier
      let existingClient;
      
      if (clientIdentifier.phone) {
        existingClient = await clientOps.getByPhoneNumber(clientIdentifier.phone);
      } else if (clientIdentifier.identifier && clientIdentifier.platform) {
        existingClient = await clientOps.getByPlatformIdentifier(
          clientIdentifier.identifier, 
          clientIdentifier.platform
        );
      } else {
        console.error('Missing required client identifier');
        return null;
      }
      
      if (!existingClient) {
        return null;
      }
      
      return existingClient.last_booking_state || {
        status: 'not_started',
        appointmentDetails: null,
        lastUpdated: null
      };
    }
  };

  // ConversationOps - Operations related to conversation history
  const conversationOps = {
    async getOrCreateSession(identifier) {
      // Handle both phone and platform identifier
      let phoneNumber, platform_id, platform;
      
      if (typeof identifier === 'string') {
        // Assume it's a phone number
        phoneNumber = identifier;
      } else if (typeof identifier === 'object') {
        if (identifier.phone) {
          phoneNumber = identifier.phone;
        } else if (identifier.identifier && identifier.platform) {
          platform_id = identifier.identifier;
          platform = identifier.platform;
        }
      }
      
      if (!phoneNumber && (!platform_id || !platform)) {
        console.error('Invalid session identifier provided');
        return null;
      }
      
      // Check if session exists based on identifier type
      let sessionQuery;
      if (phoneNumber) {
        sessionQuery = supabase
          .from('conversation_sessions')
          .select('*')
          .eq('phone_number', phoneNumber);
      } else {
        sessionQuery = supabase
          .from('conversation_sessions')
          .select('*')
          .eq('platform_id', platform_id)
          .eq('platform', platform);
      }
      
      let { data: session, error } = await sessionQuery.maybeSingle();
      
      if (!session) {
        // Session doesn't exist, create it
        const newSessionData = {};
        if (phoneNumber) {
          newSessionData.phone_number = phoneNumber;
        } else {
          newSessionData.platform_id = platform_id;
          newSessionData.platform = platform;
        }
        
        const { data: newSession, error: createError } = await supabase
          .from('conversation_sessions')
          .insert(newSessionData)
          .select()
          .single();
        
        if (createError) {
          console.error('Error creating session:', createError);
          return null;
        }
        session = newSession;
      }
      
      // Update last_active
      await supabase
        .from('conversation_sessions')
        .update({ last_active: new Date() })
        .eq('id', session.id);
      
      return session;
    },

    async addMessage(sessionId, role, content, metadata = null) {
      const { data, error } = await supabase
        .from('conversation_messages')
        .insert({
          session_id: sessionId,
          role,
          content,
          metadata
        })
        .select();
      
      if (error) {
        console.error('Error adding message:', error);
        return null;
      }
      
      return data[0];
    },

    async getConversationHistory(identifier, limit = 10) {
      // Get session based on identifier type
      const session = await this.getOrCreateSession(identifier);
      if (!session) return [];
      
      // Get messages
      const { data, error } = await supabase
        .from('conversation_messages')
        .select('*')
        .eq('session_id', session.id)
        .order('created_at', { ascending: false })
        .limit(limit);
      
      if (error) {
        console.error('Error fetching conversation history:', error);
        return [];
      }
      
      // Return messages in chronological order
      return data.reverse();
    },

    async clearSession(identifier) {
      const session = await this.getOrCreateSession(identifier);
      if (!session) return false;
      
      const { error } = await supabase
        .from('conversation_messages')
        .delete()
        .eq('session_id', session.id);
      
      if (error) {
        console.error('Error clearing session:', error);
        return false;
      }
      
      return true;
    }
  };

  // Return all operations in a single object
  return {
    supabase,
    barberOps,
    clientOps,
    appointmentOps,
    bookingStateOps,
    conversationOps
  };
}

module.exports = {
  createSupabaseClient,
  createClientOperations
};