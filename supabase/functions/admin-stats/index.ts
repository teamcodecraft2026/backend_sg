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

// Hardcoded operating cost estimate — no real fuel/wage data source yet.
// Covers driver + conductor + fuel per trip run. Adjust this number freely.
const ESTIMATED_COST_PER_TRIP = 800;

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
  return null; // 'all' — no filter
}

// 1. Define CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // 2. Handle the preflight request for CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---- 1. Auth + admin role check ----
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

    // ---- 2. Parse date range ----
    const url = new URL(req.url);
    const range = url.searchParams.get("range") ?? "all"; // 'today' | 'week' | 'all'
    const dateFrom = getDateFrom(range);

    // ---- 3. Fetch tickets with route info ----
    let ticketQuery = supabase
      .from("tickets")
      .select(
        "fare_charged, issued_at, trip_id, trips(route_id, routes(route_name, base_fare))",
      );

    if (dateFrom) ticketQuery = ticketQuery.gte("issued_at", dateFrom);

    const { data: tickets, error: ticketError } = await ticketQuery;
    if (ticketError) throw ticketError;

    // ---- 4. Aggregate revenue + discount lost, per route and total ----
    let total_revenue = 0;
    let pink_card_discount_lost = 0;
    const routeMap: Record<
      string,
      {
        route_name: string;
        revenue: number;
        tickets_sold: number;
        free_tickets: number;
      }
    > = {};

    for (const t of tickets ?? []) {
      const trip = t.trips as any;
      const route = trip?.routes as any;
      const routeName = route?.route_name ?? "Unknown route";
      const baseFare = route?.base_fare ?? 0;
      const fare = t.fare_charged ?? 0;

      total_revenue += fare;
      if (fare === 0 && baseFare > 0) pink_card_discount_lost += baseFare;

      if (!routeMap[routeName]) {
        routeMap[routeName] = {
          route_name: routeName,
          revenue: 0,
          tickets_sold: 0,
          free_tickets: 0,
        };
      }
      routeMap[routeName].revenue += fare;
      routeMap[routeName].tickets_sold += 1;
      if (fare === 0) routeMap[routeName].free_tickets += 1;
    }

    const revenue_by_route = Object.values(routeMap);

    // ---- 5. Estimated operating cost (based on trips run in range) ----
    let tripQuery = supabase.from("trips").select("id, departure_time");
    if (dateFrom) tripQuery = tripQuery.gte("departure_time", dateFrom);

    const { data: trips, error: tripError } = await tripQuery;
    if (tripError) throw tripError;

    const trip_count = trips?.length ?? 0;
    const estimated_cost = trip_count * ESTIMATED_COST_PER_TRIP;

    // ---- 6. Return ----
    return new Response(
      JSON.stringify({
        success: true,
        range,
        total_revenue,
        pink_card_discount_lost,
        revenue_by_route,
        trip_count,
        estimated_cost_per_trip: ESTIMATED_COST_PER_TRIP,
        estimated_cost,
        net_estimate: total_revenue - estimated_cost,
        cost_note:
          "estimated_cost is a hardcoded flat rate per trip — no real fuel/wage data source yet",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
