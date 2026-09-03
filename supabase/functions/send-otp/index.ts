import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  try {
    const { phone } = await req.json();

    if (!phone || typeof phone !== "string" || !/^[6-9]\d{9}$/.test(phone)) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid phone number. Must be a 10-digit Indian mobile number.",
        }),
        { status: 400 },
      );
    }

    // Invalidate any previous unused OTPs for this phone before creating a new one
    await supabase
      .from("otp_verifications")
      .update({ verified: true }) // mark as used so it can't be verified later
      .eq("phone", phone)
      .eq("verified", false);

    const otp_code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min

    const { error } = await supabase.from("otp_verifications").insert({
      phone,
      otp_code,
      expires_at,
      verified: false,
    });

    if (error) throw error;

    // MOCKED SMS: OTP returned directly instead of sent via SMS gateway
    return new Response(
      JSON.stringify({
        success: true,
        mock_sms: true,
        message: `OTP generated for ${phone} (mocked — real SMS integration pending)`,
        otp_code, // remove this field when swapping in a real SMS provider
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: "Something went wrong. Please try again." }),
      { status: 500 },
    );
  }
});
