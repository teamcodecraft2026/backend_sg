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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function getDateFrom(range: string): string | null {
  const now = new Date();
  if (range === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return start.toISOString();
  }
  if (range === "week") {
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return start.toISOString();
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── 1. Auth check ──
    const authHeader = req.headers.get("Authorization") || "";
    const userToken = authHeader.replace("Bearer ", "");

    let payload;
    try {
      payload = await verify(userToken, cryptoKey);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session token" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (payload.role !== "admin") {
      return new Response(JSON.stringify({ error: "Admin access only" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 2. Parse params ──
    const url = new URL(req.url);
    const route_name = url.searchParams.get("route_name") ?? "";
    const range = url.searchParams.get("range") ?? "all";
    const dateFrom = getDateFrom(range);

    if (!route_name) {
      return new Response(JSON.stringify({ error: "route_name is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 3. Fetch tickets for this route ──
    let query = supabase
      .from("tickets")
      .select(
        `
        id,
        fare_charged,
        status,
        issued_at,
        scanned_at,
        qr_payload,
        users(name, phone),
        trips(
          bus_number,
          departure_time,
          routes(route_name, origin, destination)
        )
      `,
      )
      .order("issued_at", { ascending: false });

    if (dateFrom) query = query.gte("issued_at", dateFrom);

    const { data: tickets, error } = await query;
    if (error) throw error;

    // ── 4. Filter by route name ──
    const filtered = (tickets ?? []).filter((t: any) => {
      const route = t.trips?.routes;
      return route?.route_name === route_name;
    });

    // ── 5. Shape response ──
    const passengers = filtered.map((t: any) => {
      const user = t.users as any;
      const trip = t.trips as any;
      const route = trip?.routes as any;
      return {
        ticket_id: t.id,
        passenger_name: user?.name ?? "Unknown",
        passenger_phone: user?.phone ?? "—",
        origin: route?.origin ?? "—",
        destination: route?.destination ?? "—",
        bus_number: trip?.bus_number ?? "—",
        departure_time: trip?.departure_time ?? null,
        issued_at: t.issued_at,
        scanned_at: t.scanned_at ?? null,
        fare_charged: t.fare_charged ?? 0,
        is_pink_card: t.fare_charged === 0,
        status: t.status,
      };
    });

    // ── 6. Summary stats ──
    const total_revenue = passengers.reduce(
      (a: number, p: any) => a + p.fare_charged,
      0,
    );
    const total_passengers = passengers.length;
    const pink_card_count = passengers.filter(
      (p: any) => p.is_pink_card,
    ).length;
    const paid_count = total_passengers - pink_card_count;

    return new Response(
      JSON.stringify({
        success: true,
        route_name,
        range,
        summary: {
          total_revenue,
          total_passengers,
          pink_card_count,
          paid_count,
        },
        passengers,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
