const { createSupabaseClient, createClientOperations } = require('../base');
require('dotenv').config();

// Get Justin-specific Supabase credentials from environment variables
// If not specified, fall back to the default Supabase credentials
const supabaseUrl = process.env.JUSTIN_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.JUSTIN_SUPABASE_KEY || process.env.SUPABASE_KEY;

// Create Supabase client for Justin
const supabase = createSupabaseClient(supabaseUrl, supabaseKey);

// Create a simplified version of operations specific to Justin's needs
// This allows for customization even when using the same database
const operations = {
  supabase,  // Keep direct access to supabase client
  
  // Barber operations - simplified for Justin's case
  barberOps: {
    async getJustinDetails() {
      const { data, error } = await supabase
        .from('barbers')
        .select('*')
        .eq('id', process.env.JUSTIN_BARBER_ID)
        .single();
        
      if (error) {
        console.error('Error fetching Justin details:', error);
      }
      return data;
    },
    
    async getJustinRefreshToken() {
      const { data, error } = await supabase
        .from('barbers')
        .select('refresh_token')
        .eq('id', process.env.JUSTIN_BARBER_ID)
        .single();
        
      if (error) {
        console.error('Error fetching Justin refresh token:', error);
        return null;
      }
      return data?.refresh_token;
    }
  },
  
  // Client operations - specific to Justin's clients
  clientOps: {
    async getByPlatformId(identifier, platform) {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .eq('identifier', identifier)
        .eq('platform', platform)
        .single();
        
      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching client:', error);
      }
      return data;
    },
    
    async createClient(clientData) {
      const { data, error } = await supabase
        .from('clients')
        .insert({
          ...clientData,
          preferred_barber_id: process.env.JUSTIN_BARBER_ID
        })
        .select();
        
      if (error) {
        console.error('Error creating client:', error);
        return null;
      }
      return data[0];
    }
  },
  
  // Appointment operations - specific to Justin's appointments
  appointmentOps: {
    async create(appointmentData) {
      const { data, error } = await supabase
        .from('appointments')
        .insert({
          ...appointmentData,
          barber_id: process.env.JUSTIN_BARBER_ID
        })
        .select();
        
      if (error) {
        console.error('Error creating appointment:', error);
        return null;
      }
      return data[0];
    },
    
    async findByClientIdentifier(identifier, platform) {
      const { data, error } = await supabase
        .from('appointments')
        .select('*')
        .eq('client_identifier', identifier)
        .eq('platform', platform)
        .eq('barber_id', process.env.JUSTIN_BARBER_ID)
        .order('start_time', { ascending: false });
        
      if (error) {
        console.error('Error finding appointments:', error);
        return [];
      }
      return data;
    },
    
    async cancelAppointment(googleCalendarEventId) {
      const { data, error } = await supabase
        .from('appointments')
        .delete()
        .eq('google_calendar_event_id', googleCalendarEventId)
        .eq('barber_id', process.env.JUSTIN_BARBER_ID);
        
      if (error) {
        console.error('Error cancelling appointment:', error);
        return false;
      }
      return true;
    }
  }
};

module.exports = operations;