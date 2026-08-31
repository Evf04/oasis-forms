import { createClient } from '@supabase/supabase-js';

// Read client-side environment variables in Astro/Vite
const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL?.trim() || '';
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY?.trim() || '';

export function getSupabaseClient() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Faltan las credenciales de Supabase en el archivo .env (PUBLIC_SUPABASE_URL y PUBLIC_SUPABASE_ANON_KEY).'
    );
  }

  if (
    supabaseUrl.includes('your-project-id') ||
    supabaseUrl.includes('placeholder') ||
    supabaseAnonKey.includes('your-supabase-anon-key')
  ) {
    throw new Error(
      'Debes configurar tu URL de proyecto y Anon Key reales en el archivo .env antes de registrar datos.'
    );
  }

  return createClient(supabaseUrl, supabaseAnonKey);
}

export interface OasisRegistrationInput {
  tienda: 'malabia' | 'unicenter';
  nombre: string;
  dni: string;
  telefono: string;
  email: string;
  ticketFile: File;
}

export async function submitRegistration(input: OasisRegistrationInput) {
  // 1. Validate connection parameters strictly - NO MOCK/DEMO FALLBACKS
  const client = getSupabaseClient();

  const cleanDni = input.dni.replace(/[^0-9]/g, '');
  const cleanTel = input.telefono.replace(/[^0-9]/g, '');
  const cleanEmail = input.email.toLowerCase().trim();

  if (!cleanDni || cleanDni.length < 7) {
    throw new Error('El DNI ingresado no es válido.');
  }

  if (!cleanTel || cleanTel.length < 6) {
    throw new Error('El teléfono ingresado no es válido.');
  }

  if (!cleanEmail.includes('@')) {
    throw new Error('El correo electrónico no es válido.');
  }

  if (!input.ticketFile) {
    throw new Error('Debes adjuntar una foto o comprobante de compra.');
  }

  // 2. Upload ticket to Supabase Storage bucket 'tickets'
  const fileExt = input.ticketFile.name.split('.').pop() || 'webp';
  const fileName = `${cleanDni}_${cleanTel}.${fileExt}`;
  const filePath = fileName;

  const { data: uploadData, error: uploadError } = await client.storage
    .from('tickets')
    .upload(filePath, input.ticketFile, {
      contentType: input.ticketFile.type,
      upsert: true,
    });

  if (uploadError) {
    console.error('[Supabase Storage Error]', uploadError);
    if (uploadError.message.includes('Bucket not found') || uploadError.message.includes('bucket')) {
      throw new Error(
        'El bucket "tickets" no existe en Supabase Storage. Ejecuta el script SQL en Supabase para crearlo.'
      );
    }
    throw new Error(`Error al subir el comprobante a Supabase Storage: ${uploadError.message}`);
  }

  // 3. Obtain the public URL
  const { data: publicUrlData } = client.storage
    .from('tickets')
    .getPublicUrl(filePath);

  const ticketUrl = publicUrlData?.publicUrl || `${supabaseUrl}/storage/v1/object/public/tickets/${filePath}`;

  // 4. Insert into 'oasis_registrations' table
  const { data: registrationData, error: insertError } = await client
    .from('oasis_registrations')
    .insert([
      {
        tienda: input.tienda,
        nombre: input.nombre.trim(),
        dni: cleanDni,
        telefono: cleanTel,
        email: cleanEmail,
        ticket_url: ticketUrl,
        ticket_filename: fileName,
        ticket_size_bytes: input.ticketFile.size,
      },
    ])
    .select()
    .single();

  if (insertError) {
    console.error('[Supabase Database Insert Error]', insertError);

    // Specific PostgreSQL Unique Constraint Error (23505)
    if (insertError.code === '23505') {
      const details = (insertError.details || insertError.message || '').toLowerCase();
      if (details.includes('dni') || insertError.message.includes('dni')) {
        throw new Error('Este DNI ya se encuentra registrado.');
      }
      if (details.includes('telefono') || insertError.message.includes('telefono')) {
        throw new Error('Este número de teléfono ya se encuentra registrado.');
      }
      if (details.includes('email') || insertError.message.includes('email')) {
        throw new Error('Este correo electrónico ya se encuentra registrado.');
      }
      throw new Error('Ya existe un registro con estos datos de contacto.');
    }

    if (insertError.message.includes('relation "public.oasis_registrations" does not exist')) {
      throw new Error(
        'La tabla "oasis_registrations" no existe en la base de datos. Ejecuta el script SQL en Supabase primero.'
      );
    }

    throw new Error(`Error al guardar en la base de datos: ${insertError.message}`);
  }

  // 5. Strict verification that the record was created
  if (!registrationData || !registrationData.id) {
    throw new Error('No se pudo confirmar la creación del registro en la base de datos.');
  }

  return {
    success: true,
    data: registrationData,
  };
}
