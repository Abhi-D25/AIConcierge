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

// Client operations
const clientOps = {
  async getByPhoneNumber(phoneNumber) {
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single();
      
    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching client:', error);
    }
    return data;
  },

  async createOrUpdate(clientData) {
    const { 
      phone_number, 
      name, 
      email = null, 
      skin_type = null,
      skin_tone = null,
      allergies = null,
      preferred_service_type = null,
      special_notes = null
    } = clientData;
    
    // Check if client exists
    const existingClient = await this.getByPhoneNumber(phone_number);
    
    if (existingClient) {
      // Update existing client
      const { data, error } = await supabase
        .from('clients')
        .update({
          name: name || existingClient.name,
          email: email || existingClient.email,
          skin_type: skin_type || existingClient.skin_type,
          skin_tone: skin_tone || existingClient.skin_tone,
          allergies: allergies || existingClient.allergies,
          preferred_service_type: preferred_service_type || existingClient.preferred_service_type,
          special_notes: special_notes || existingClient.special_notes,
          updated_at: new Date()
        })
        .eq('phone_number', phone_number)
        .select();
        
      if (error) {
        console.error('Error updating client:', error);
        return null;
      }
      
      return data[0];
    } else {
      // Create new client
      const { data, error } = await supabase
        .from('clients')
        .insert({
          phone_number,
          name: name || 'New Client',
          email,
          skin_type,
          skin_tone,
          allergies,
          preferred_service_type,
          special_notes
        })
        .select();
        
      if (error) {
        console.error('Error creating client:', error);
        return null;
      }
      
      return data[0];
    }
  }
};

// Service operations
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

// Location operations
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

// Appointment operations
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
  }
};

// Group bookings operations
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

// Portfolio operations
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

// Conversation operations
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

// Export all operations
module.exports = {
  supabase,
  clientOps,
  serviceOps,
  locationOps,
  appointmentOps,
  groupBookingOps,
  portfolioOps,
  conversationOps
};