// utils/supabase.js
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Create Supabase client
const supabaseUrl = process.env.MAKEUP_ARTIST_SUPABASE_URL;
const supabaseKey = process.env.MAKEUP_ARTIST_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Client operations - UPDATED WITH STATUS MANAGEMENT
const clientOps = {
    async getByPhoneNumber(phoneNumber) {
      console.log('Fetching client with phone number:', phoneNumber);
      
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();
        
      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching client:', error);
      }
      
      console.log('Client fetch result:', data || 'Not found');
      return data;
    },
  
    async createOrUpdate(clientData) {
      console.log('Creating/updating client with data:', clientData);
      
      const { 
        phone_number, 
        name, 
        email = null, 
        skin_type = null,
        skin_tone = null,
        allergies = null,
        preferred_service_type = null,
        special_notes = null,
        status = 'Lead', // NEW: Default status for new clients
        status_notes = null // NEW: Notes about status changes
      } = clientData;
      
      // Check if client exists
      const existingClient = await this.getByPhoneNumber(phone_number);
      
      try {
        if (existingClient) {
          console.log('Updating existing client:', existingClient.id);
          
          // Update existing client - only update provided fields
          const updateData = {
            updated_at: new Date().toISOString()
          };
          
          // Only update fields that are provided and different
          if (name && name !== existingClient.name) updateData.name = name;
          if (email && email !== existingClient.email) updateData.email = email;
          if (skin_type && skin_type !== existingClient.skin_type) updateData.skin_type = skin_type;
          if (skin_tone && skin_tone !== existingClient.skin_tone) updateData.skin_tone = skin_tone;
          if (allergies && allergies !== existingClient.allergies) updateData.allergies = allergies;
          if (preferred_service_type && preferred_service_type !== existingClient.preferred_service_type) {
            updateData.preferred_service_type = preferred_service_type;
          }
          if (special_notes && special_notes !== existingClient.special_notes) updateData.special_notes = special_notes;
          
          // NEW: Handle status updates
          if (status && status !== existingClient.status) updateData.status = status;
          if (status_notes) updateData.status_notes = status_notes;
          
          const { data, error } = await supabase
            .from('clients')
            .update(updateData)
            .eq('id', existingClient.id)
            .select();
            
          if (error) {
            console.error('Error updating client:', error);
            return null;
          }
          
          console.log('Client updated successfully:', data);
          return data[0];
        } else {
          console.log('Creating new client');
          
          // Create new client
          const insertData = {
            phone_number,
            name: name || 'New Client',
            email,
            skin_type,
            skin_tone,
            allergies,
            preferred_service_type,
            special_notes,
            status: status || 'Lead', // NEW: Set initial status
            status_notes
          };
          
          console.log('Insert data:', insertData);
          
          const { data, error } = await supabase
            .from('clients')
            .insert(insertData)
            .select();
            
          if (error) {
            console.error('Error creating client:', error);
            return null;
          }
          
          console.log('Client created successfully:', data);
          return data[0];
        }
      } catch (err) {
        console.error('Exception in createOrUpdate:', err);
        return null;
      }
    },

    // NEW: Status management method
    async updateStatus(phoneNumber, newStatus, notes = null) {
      console.log(`Updating client status for ${phoneNumber} to ${newStatus}`);
      
      const validStatuses = ['Lead', 'Active', 'Needs Confirmation', 'Payment Due'];
      if (!validStatuses.includes(newStatus)) {
        console.error('Invalid status:', newStatus);
        return null;
      }
      
      const updateData = {
        status: newStatus,
        updated_at: new Date().toISOString()
      };
      
      if (notes) {
        updateData.status_notes = notes;
      }
      
      const { data, error } = await supabase
        .from('clients')
        .update(updateData)
        .eq('phone_number', phoneNumber)
        .select();
      
      if (error) {
        console.error('Error updating client status:', error);
        return null;
      }
      
      console.log('Client status updated successfully:', data[0]);
      return data[0];
    },

    // NEW: Get clients by status
    async getByStatus(status) {
      console.log(`Fetching clients with status: ${status}`);
      
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .eq('status', status)
        .order('updated_at', { ascending: false });
      
      if (error) {
        console.error('Error fetching clients by status:', error);
        return [];
      }
      
      return data;
    },

    // NEW: Get client with appointment summary
    async getWithAppointmentSummary(phoneNumber) {
      const client = await this.getByPhoneNumber(phoneNumber);
      if (!client) return null;
      
      // Get pending appointments
      const { data: pendingAppointments } = await supabase
        .from('appointments')
        .select('*')
        .eq('client_phone', phoneNumber)
        .eq('status', 'pending_confirmation')
        .order('created_at', { ascending: false });
      
      // Get upcoming appointments
      const { data: upcomingAppointments } = await supabase
        .from('appointments')
        .select('*')
        .eq('client_phone', phoneNumber)
        .in('status', ['pending', 'confirmed'])
        .gte('start_time', new Date().toISOString())
        .order('start_time', { ascending: true });
      
      return {
        ...client,
        pendingAppointments: pendingAppointments || [],
        upcomingAppointments: upcomingAppointments || [],
        hasPendingConfirmations: (pendingAppointments || []).length > 0,
        hasUpcomingAppointments: (upcomingAppointments || []).length > 0
      };
    }
  };

// Service operations (unchanged)
const serviceOps = {
  async getAll() {
    const { data, error } = await supabase
      .from('services')
      .select('*')
      .order('base_price', { ascending: true });
      
    if (error) {
      console.error('Error fetching services:', error);
      return [];
    }
    
    return data;
  },
  
  async getById(serviceId) {
    const { data, error } = await supabase
      .from('services')
      .select('*')
      .eq('id', serviceId)
      .single();
      
    if (error) {
      console.error('Error fetching service:', error);
      return null;
    }
    
    return data;
  },
  
  async getByName(serviceName) {
    const { data, error } = await supabase
      .from('services')
      .select('*')
      .ilike('name', `%${serviceName}%`)
      .order('base_price', { ascending: true });
      
    if (error) {
      console.error('Error fetching services by name:', error);
      return [];
    }
    
    return data;
  }
};

// Location operations (unchanged)
const locationOps = {
  async getAll() {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .order('travel_fee', { ascending: true });
      
    if (error) {
      console.error('Error fetching locations:', error);
      return [];
    }
    
    return data;
  },
  
  async getById(locationId) {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .eq('id', locationId)
      .single();
      
    if (error) {
      console.error('Error fetching location:', error);
      return null;
    }
    
    return data;
  },
  
  async getByName(locationName) {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .ilike('name', `%${locationName}%`)
      .order('travel_fee', { ascending: true });
      
    if (error) {
      console.error('Error fetching locations by name:', error);
      return [];
    }
    
    return data;
  }
};

// Appointment operations (unchanged)
const appointmentOps = {
  async create(appointmentData) {
    const { 
      client_phone, 
      service_id, 
      location_id,
      specific_address,
      start_time, 
      end_time, 
      google_calendar_event_id,
      status = 'pending',
      deposit_amount = null,
      deposit_status = 'pending',
      total_amount = null,
      payment_status = 'pending',
      payment_method = null,
      notes = null
    } = appointmentData;
    
    const { data, error } = await supabase
      .from('appointments')
      .insert({
        client_phone,
        service_id,
        location_id,
        specific_address,
        start_time,
        end_time,
        google_calendar_event_id,
        status,
        deposit_amount,
        deposit_status,
        total_amount,
        payment_status,
        payment_method,
        notes
      })
      .select();
      
    if (error) {
      console.error('Error creating appointment:', error);
      return null;
    }
    
    return data[0];
  },
  
  async update(appointmentId, updateData) {
    const { data, error } = await supabase
      .from('appointments')
      .update({
        ...updateData,
        updated_at: new Date()
      })
      .eq('id', appointmentId)
      .select();
      
    if (error) {
      console.error('Error updating appointment:', error);
      return null;
    }
    
    return data[0];
  },
  
  async updateByEventId(eventId, updateData) {
    const { data, error } = await supabase
      .from('appointments')
      .update({
        ...updateData,
        updated_at: new Date()
      })
      .eq('google_calendar_event_id', eventId)
      .select();
      
    if (error) {
      console.error('Error updating appointment by event ID:', error);
      return null;
    }
    
    return data[0];
  },
  
  async getUpcomingByClient(clientPhone) {
    const { data, error } = await supabase
      .from('appointments')
      .select(`
        *,
        service:services(*),
        location:locations(*)
      `)
      .eq('client_phone', clientPhone)
      .gte('start_time', new Date().toISOString())
      .in('status', ['pending', 'confirmed'])
      .order('start_time', { ascending: true });
      
    if (error) {
      console.error('Error fetching upcoming appointments:', error);
      return [];
    }
    
    return data;
  },
  
  async getAllUpcoming() {
    const { data, error } = await supabase
      .from('appointments')
      .select(`
        *,
        client:clients(name, phone_number),
        service:services(name, base_price, duration_minutes),
        location:locations(name, travel_fee)
      `)
      .gte('start_time', new Date().toISOString())
      .in('status', ['pending', 'confirmed'])
      .order('start_time', { ascending: true });
      
    if (error) {
      console.error('Error fetching all upcoming appointments:', error);
      return [];
    }
    
    return data;
  },

  // NEW: Get pending confirmations
  async getPendingConfirmations() {
    const { data, error } = await supabase
      .from('appointments')
      .select(`
        *,
        client:clients(name, phone_number, skin_type, skin_tone, allergies)
      `)
      .eq('status', 'pending_confirmation')
      .order('created_at', { ascending: true });
    
    if (error) {
      console.error('Error fetching pending confirmations:', error);
      return [];
    }
    
    return data;
  }
};

// Group bookings operations (unchanged)
const groupBookingOps = {
  async create(groupBookingData) {
    const { 
      main_appointment_id, 
      client_phone, 
      client_name,
      service_id,
      price,
      notes
    } = groupBookingData;
    
    const { data, error } = await supabase
      .from('group_bookings')
      .insert({
        main_appointment_id,
        client_phone,
        client_name,
        service_id,
        price,
        notes
      })
      .select();
      
    if (error) {
      console.error('Error creating group booking:', error);
      return null;
    }
    
    return data[0];
  },
  
  async getByAppointmentId(appointmentId) {
    const { data, error } = await supabase
      .from('group_bookings')
      .select(`
        *,
        service:services(name, base_price, duration_minutes)
      `)
      .eq('main_appointment_id', appointmentId);
      
    if (error) {
      console.error('Error fetching group bookings:', error);
      return [];
    }
    
    return data;
  }
};

// Portfolio operations (unchanged)
const portfolioOps = {
  async getAll(limit = 10) {
    const { data, error } = await supabase
      .from('portfolio')
      .select(`
        *,
        service:services(name)
      `)
      .order('created_at', { ascending: false })
      .limit(limit);
      
    if (error) {
      console.error('Error fetching portfolio items:', error);
      return [];
    }
    
    return data;
  },
  
  async getByService(serviceId, limit = 10) {
    const { data, error } = await supabase
      .from('portfolio')
      .select(`
        *,
        service:services(name)
      `)
      .eq('service_id', serviceId)
      .order('created_at', { ascending: false })
      .limit(limit);
      
    if (error) {
      console.error('Error fetching portfolio items by service:', error);
      return [];
    }
    
    return data;
  },
  
  async getBySkinTone(skinTone, limit = 10) {
    const { data, error } = await supabase
      .from('portfolio')
      .select(`
        *,
        service:services(name)
      `)
      .ilike('skin_tone', `%${skinTone}%`)
      .order('created_at', { ascending: false })
      .limit(limit);
      
    if (error) {
      console.error('Error fetching portfolio items by skin tone:', error);
      return [];
    }
    
    return data;
  }
};

// Conversation operations (unchanged)
const conversationOps = {
  async getOrCreateSession(phoneNumber) {
    // Check if session exists
    let { data: session, error } = await supabase
      .from('conversation_sessions')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single();
    
    if (error && error.code === 'PGRST116') {
      // Session doesn't exist, create it
      const { data: newSession, error: createError } = await supabase
        .from('conversation_sessions')
        .insert({ phone_number: phoneNumber })
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

  async getConversationHistory(phoneNumber, limit = 10) {
    // Get session
    const session = await this.getOrCreateSession(phoneNumber);
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

  async clearSession(phoneNumber) {
    const session = await this.getOrCreateSession(phoneNumber);
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

// Makeup Artist operations (unchanged)
const makeupArtistOps = {
    async getAll() {
      const { data, error } = await supabase
        .from('makeup_artists')
        .select('*');
        
      if (error) {
        console.error('Error fetching makeup artists:', error);
        return [];
      }
      
      return data;
    },
    
    async getById(id) {
      const { data, error } = await supabase
        .from('makeup_artists')
        .select('*')
        .eq('id', id)
        .single();
        
      if (error) {
        console.error('Error fetching makeup artist by ID:', error);
        return null;
      }
      
      return data;
    },
    
    async getByPhoneNumber(phoneNumber) {
      const { data, error } = await supabase
        .from('makeup_artists')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();
        
      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching makeup artist by phone:', error);
      }
      
      return data;
    },
    
    async getWithRefreshToken() {
      const { data, error } = await supabase
        .from('makeup_artists')
        .select('*')
        .not('refresh_token', 'is', null)
        .limit(1)
        .single();
        
      if (error) {
        console.error('Error fetching makeup artist with refresh token:', error);
        return null;
      }
      
      return data;
    },
    
    async updateOrCreate(artistData) {
      const { 
        phone_number, 
        name, 
        email, 
        refresh_token, 
        selected_calendar_id,
        business_hours_start,
        business_hours_end,
        instagram_handle,
        website_url,
        bio
      } = artistData;
      
      // Check if artist exists
      const existingArtist = await this.getByPhoneNumber(phone_number);
      
      if (existingArtist) {
        // Update existing artist
        const { data, error } = await supabase
          .from('makeup_artists')
          .update({
            name: name || existingArtist.name,
            email: email || existingArtist.email,
            refresh_token: refresh_token || existingArtist.refresh_token,
            selected_calendar_id: selected_calendar_id || existingArtist.selected_calendar_id,
            business_hours_start: business_hours_start || existingArtist.business_hours_start,
            business_hours_end: business_hours_end || existingArtist.business_hours_end,
            instagram_handle: instagram_handle || existingArtist.instagram_handle,
            website_url: website_url || existingArtist.website_url,
            bio: bio || existingArtist.bio,
            updated_at: new Date()
          })
          .eq('phone_number', phone_number)
          .select();
          
        if (error) {
          console.error('Error updating makeup artist:', error);
          return null;
        }
        
        return data[0];
      } else {
        // Create new makeup artist
        const { data, error } = await supabase
          .from('makeup_artists')
          .insert({
            phone_number,
            name: name || 'New Makeup Artist',
            email,
            refresh_token,
            selected_calendar_id: selected_calendar_id || 'primary',
            business_hours_start,
            business_hours_end,
            instagram_handle,
            website_url,
            bio
          })
          .select();
          
        if (error) {
          console.error('Error creating makeup artist:', error);
          return null;
        }
        
        return data[0];
      }
    },
    
    async updateCalendarId(phoneNumber, calendarId) {
      const { data, error } = await supabase
        .from('makeup_artists')
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
    
    async updateRefreshToken(phoneNumber, refreshToken) {
      const { data, error } = await supabase
        .from('makeup_artists')
        .update({
          refresh_token: refreshToken,
          updated_at: new Date()
        })
        .eq('phone_number', phoneNumber)
        .select();
        
      if (error) {
        console.error('Error updating refresh token:', error);
        return null;
      }
      
      return data[0];
    },
    
    async updateBusinessHours(phoneNumber, startTime, endTime) {
      const { data, error } = await supabase
        .from('makeup_artists')
        .update({
          business_hours_start: startTime,
          business_hours_end: endTime,
          updated_at: new Date()
        })
        .eq('phone_number', phoneNumber)
        .select();
        
      if (error) {
        console.error('Error updating business hours:', error);
        return null;
      }
      
      return data[0];
    }
  };

// Export all operations
module.exports = {
  supabase,
  clientOps,
  serviceOps,
  locationOps,
  appointmentOps,
  groupBookingOps,
  portfolioOps,
  conversationOps,
  makeupArtistOps
};