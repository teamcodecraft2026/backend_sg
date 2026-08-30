import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  try {
    const { phone } = await req.json()

    if (!phone || typeof phone !== 'string') {
      return new Response(JSON.stringify({ error: 'phone is required' }), { status: 400 })
    }

    const otp_code = Math.floor(100000 + Math.random() * 900000).toString()
    const expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString() // 5 min

    const { error } = await supabase.from('otp_verifications').insert({
      phone,
      otp_code,
      expires_at,
      verified: false
    })

    if (error) throw error

    // MOCKED SMS: OTP returned directly instead of sent via SMS gateway
    return new Response(JSON.stringify({
      success: true,
      mock_sms: true,
      message: `OTP generated for ${phone} (mocked — real SMS integration pending)`,
      otp_code // remove this field when swapping in a real SMS provider
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})