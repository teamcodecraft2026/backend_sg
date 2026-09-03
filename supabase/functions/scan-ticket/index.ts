import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const encoder = new TextEncoder();
const keyData = encoder.encode(Deno.env.get("JWT_SECRET")!);
const cryptoKey = await crypto.subtle.importKey(
  "raw",
  keyData,
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["verify"],
);

Deno.serve(async (req) => {
  try {
    // ---- 1. Auth ----
    const authHeader = req.headers.get("Authorization") || "";
    const userToken = authHeader.replace("Bearer ", "");

    let payload;
    try {
      payload = await verify(userToken, cryptoKey);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session token" }),
        { status: 401 },
      );
    }

    const conductor_id = payload.sub as string;
    const role = payload.role as string;

    // ---- 2. Enforce conductor role ----
    if (role !== "conductor") {
      return new Response(
        JSON.stringify({ error: "Only conductors can scan tickets" }),
        { status: 403 },
      );
    }

    // ---- 3. Get ticket_id (from QR payload) and optionally trip_id ----
    const { ticket_id, trip_id } = await req.json();

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!ticket_id || !uuidPattern.test(ticket_id)) {
      return new Response(
        JSON.stringify({ error: "Invalid ticket_id format" }),
        { status: 400 },
      );
    }

    // ---- 4. Look up the ticket ----
    const { data: ticket, error: ticketError } = await supabase
      .from("tickets")
      .select("*")
      .eq("id", ticket_id)
      .single();

    let scan_result: string;
    let responseBody: Record<string, unknown>;

    if (ticketError || !ticket) {
      scan_result = "invalid";
      responseBody = { valid: false, reason: "Ticket not found" };
    } else if (ticket.status === "scanned") {
      scan_result = "already_used";
      responseBody = {
        valid: false,
        reason: "Ticket already used",
        scanned_at: ticket.scanned_at,
      };
    } else if (ticket.status === "expired" || ticket.status === "cancelled") {
      scan_result = "expired";
      responseBody = { valid: false, reason: `Ticket is ${ticket.status}` };
    } else if (trip_id && ticket.trip_id !== trip_id) {
      scan_result = "invalid";
      responseBody = {
        valid: false,
        reason: "Ticket is not valid for this trip",
      };
    } else {
      // valid — mark as scanned
      const { error: updateError } = await supabase
        .from("tickets")
        .update({ status: "scanned", scanned_at: new Date().toISOString() })
        .eq("id", ticket_id);

      if (updateError) throw updateError;

      scan_result = "valid";
      responseBody = {
        valid: true,
        reason: "Boarding approved",
        ticket_id: ticket.id,
        fare_charged: ticket.fare_charged,
      };
    }

    // ---- 5. Log the scan attempt (always, regardless of outcome) ----
    await supabase.from("ticket_scans").insert({
      ticket_id: ticket?.id ?? null,
      conductor_id,
      scan_result,
    });

    return new Response(
      JSON.stringify({ success: true, scan_result, ...responseBody }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: "Something went wrong. Please try again." }),
      { status: 500 },
    );
  }
});
