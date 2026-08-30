import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verify } from 'https://deno.land/x/djwt@v3.0.1/mod.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const encoder = new TextEncoder()
const keyData = encoder.encode(Deno.env.get('JWT_SECRET')!)
const cryptoKey = await crypto.subtle.importKey(
  'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
)

const THRESHOLD = 250000

Deno.serve(async (req) => {
  try {
    // ---- 1. Authenticate the caller via our own JWT (from verify-otp) ----
    const authHeader = req.headers.get('Authorization') || ''
    const userToken = authHeader.replace('Bearer ', '')

    let payload
    try {
      payload = await verify(userToken, cryptoKey)
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid or expired session token' }), { status: 401 })
    }

    const user_id = payload.sub as string

    // ---- 2. Get PAN from request ----
    const { pan } = await req.json()
    if (!pan || typeof pan !== 'string') {
      return new Response(JSON.stringify({ error: 'pan is required' }), { status: 400 })
    }

    // ---- 3. Look up "government income database" (hardcoded table) ----
    const { data: record, error: lookupError } = await supabase
      .from('pink_card_income_records')
      .select('*')
      .eq('pan', pan.toUpperCase())
      .single()

    let result

    if (lookupError || !record) {
      // PAN not found
      result = {
        pan: pan.toUpperCase(),
        eligible: false,
        gender: null,
        annual_income: null,
        threshold: THRESHOLD,
        gap: null,
        reason_code: 'INELIGIBLE_NO_RECORD',
        reason_message: 'No income record found for this PAN.'
      }
    } else if (record.gender !== 'F') {
      result = {
        pan: record.pan,
        eligible: false,
        gender: record.gender,
        annual_income: record.annual_income,
        threshold: THRESHOLD,
        gap: null,
        reason_code: 'INELIGIBLE_GENDER',
        reason_message: 'Pink Card is only available to female applicants.'
      }
    } else if (record.annual_income > THRESHOLD) {
      const gap = record.annual_income - THRESHOLD
      result = {
        pan: record.pan,
        eligible: false,
        gender: record.gender,
        annual_income: record.annual_income,
        threshold: THRESHOLD,
        gap,
        reason_code: 'INELIGIBLE_INCOME_HIGH',
        reason_message: `Income exceeds the threshold by ₹${gap.toLocaleString('en-IN')}.`
      }
    } else {
      const gap = record.annual_income - THRESHOLD // negative = under threshold
      result = {
        pan: record.pan,
        eligible: true,
        gender: record.gender,
        annual_income: record.annual_income,
        threshold: THRESHOLD,
        gap,
        reason_code: 'ELIGIBLE_INCOME_GENDER',
        reason_message: `Eligible: income is ₹${Math.abs(gap).toLocaleString('en-IN')} below the threshold.`
      }
    }

    // ---- 4. Log this application/check to pink_card_applications ----
    const { data: savedApp, error: insertError } = await supabase
      .from('pink_card_applications')
      .insert({
        user_id,
        pan: result.pan,
        eligible: result.eligible,
        gender: result.gender,
        annual_income: result.annual_income,
        threshold: result.threshold,
        gap: result.gap,
        reason_code: result.reason_code,
        reason_message: result.reason_message
      })
      .select()
      .single()

    if (insertError) throw insertError

    // ---- 5. Return full breakdown ----
    return new Response(JSON.stringify({ success: true, application_id: savedApp.id, ...result }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})