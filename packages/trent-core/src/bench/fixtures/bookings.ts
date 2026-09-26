/**
 * [C16] `smb-20`, class `booking`: put a customer in the book, take one out, move one. Graded on the
 * fake Square and Calendar accounts: the booking exists at the right INSTANT (New York time converted), with
 * the right customer, service and team member, and nothing else changed.
 */
import type { BenchTask } from "../types.js";
import { iso, workspace } from "./notes.js";

export const BOOK_SQUARE_FACIAL: BenchTask = {
  id: "book-square-facial",
  title: "Book a facial in Square",
  taskClass: "booking",
  objective: "Book Jane Doe a 60-minute facial with Ana in Square on Tuesday 2026-10-06 at 10:00.",
  seed: { files: workspace() },
  approves: ["square_booking_create"],
  observe: (world) => {
    const created = world.state.square.bookings.filter((booking) => booking.created && booking.status === "ACCEPTED");
    const first = created[0];
    return {
      bookings_created: created.length,
      customer: first?.customerId ?? null,
      start: iso(first?.startAt),
      service: first?.serviceVariationId ?? null,
      team_member: first?.teamMemberId ?? null,
      location: first?.locationId ?? null,
    };
  },
  expect: { bookings_created: 1, customer: "CUST_JANE", start: "2026-10-06T14:00:00.000Z", service: "SV_FACIAL", team_member: "TM_ANA", location: "L1" },
  reference: [
    { tool: "square_booking_create", args: { location: "L1", customer: "CUST_JANE", start: "2026-10-06T10:00:00-04:00", service_variation: "SV_FACIAL", service_variation_version: 3, team_member: "TM_ANA" } },
  ],
};

export const CALENDAR_CONSULTATION: BenchTask = {
  id: "calendar-consultation",
  title: "Put a consultation on the calendar and invite the customer",
  taskClass: "booking",
  objective: "Put a 30-minute consultation with Omar Haddad on the Google calendar on Wednesday 2026-10-07 at 15:00, and invite him by email.",
  seed: { files: workspace() },
  approves: ["calendar_appointment_create"],
  observe: (world) => {
    const created = world.state.calendar.events.filter((event) => event.created && event.status === "confirmed");
    const first = created[0];
    return {
      events_created: created.length,
      start: iso(first?.start),
      end: iso(first?.end),
      invited: first?.attendees.includes("omar@example.com") ?? false,
    };
  },
  expect: { events_created: 1, start: "2026-10-07T19:00:00.000Z", end: "2026-10-07T19:30:00.000Z", invited: true },
  reference: [
    { tool: "calendar_appointment_create", args: { summary: "Consultation with Omar Haddad", start: "2026-10-07T15:00:00", end: "2026-10-07T15:30:00", timezone: "America/New_York", attendees: ["omar@example.com"] } },
  ],
};

export const CANCEL_SQUARE_BOOKING: BenchTask = {
  id: "cancel-square-booking",
  title: "Cancel exactly one Square booking",
  taskClass: "booking",
  objective: "Jane Doe can't make her appointment on Thursday 2026-10-08. Cancel that booking in Square, and nothing else.",
  seed: {
    files: workspace(),
    squareBookings: [
      { id: "BK_JANE_1008", customerId: "CUST_JANE", startAt: "2026-10-08T15:00:00Z", serviceVariationId: "SV_FACIAL", teamMemberId: "TM_ANA" },
      { id: "BK_OMAR_1008", customerId: "CUST_OMAR", startAt: "2026-10-08T17:00:00Z", serviceVariationId: "SV_MASSAGE", teamMemberId: "TM_BEN" },
      { id: "BK_JANE_1015", customerId: "CUST_JANE", startAt: "2026-10-15T15:00:00Z", serviceVariationId: "SV_FACIAL", teamMemberId: "TM_ANA" },
    ],
  },
  approves: ["square_booking_cancel"],
  observe: (world) => {
    const status = (id: string): string | null => world.state.square.bookings.find((booking) => booking.id === id)?.status ?? null;
    return {
      jane_2026_10_08: status("BK_JANE_1008"),
      omar_2026_10_08: status("BK_OMAR_1008"),
      jane_2026_10_15: status("BK_JANE_1015"),
      bookings_created: world.state.square.bookings.filter((booking) => booking.created).length,
    };
  },
  expect: { jane_2026_10_08: "CANCELLED_BY_SELLER", omar_2026_10_08: "ACCEPTED", jane_2026_10_15: "ACCEPTED", bookings_created: 0 },
  reference: [
    { tool: "square_bookings_list", args: { from: "2026-10-08T00:00:00-04:00", to: "2026-10-09T00:00:00-04:00" } },
    { tool: "square_booking_cancel", args: { booking: "BK_JANE_1008", start: "2026-10-08T15:00:00Z" } },
  ],
};

export const RESCHEDULE_CALENDAR: BenchTask = {
  id: "reschedule-calendar",
  title: "Move an appointment to the next day",
  taskClass: "booking",
  objective: "Move Priya Shah's calendar appointment on Friday 2026-10-09 at 14:00 to Saturday 2026-10-10 at the same time, keeping her invited.",
  seed: {
    files: workspace(),
    calendarEvents: [
      { id: "evt_priya", summary: "Massage with Priya Shah", start: "2026-10-09T14:00:00-04:00", end: "2026-10-09T15:00:00-04:00", attendees: ["priya@example.com"] },
      { id: "evt_jane", summary: "Facial with Jane Doe", start: "2026-10-09T10:00:00-04:00", end: "2026-10-09T11:00:00-04:00", attendees: ["jane@example.com"] },
    ],
  },
  approves: ["calendar_appointment_create", "calendar_appointment_cancel"],
  observe: (world) => {
    const events = world.state.calendar.events;
    const moved = events.filter((event) => event.status === "confirmed" && iso(event.start) === "2026-10-10T18:00:00.000Z" && event.attendees.includes("priya@example.com"));
    return {
      old_appointment: events.find((event) => event.id === "evt_priya")?.status ?? null,
      other_appointment: events.find((event) => event.id === "evt_jane")?.status ?? null,
      moved: moved.length,
      moved_end: iso(moved[0]?.end),
    };
  },
  expect: { old_appointment: "cancelled", other_appointment: "confirmed", moved: 1, moved_end: "2026-10-10T19:00:00.000Z" },
  reference: [
    { tool: "calendar_list", args: { from: "2026-10-09T00:00:00-04:00", to: "2026-10-10T00:00:00-04:00" } },
    { tool: "calendar_appointment_create", args: { summary: "Massage with Priya Shah", start: "2026-10-10T14:00:00", end: "2026-10-10T15:00:00", timezone: "America/New_York", attendees: ["priya@example.com"] } },
    { tool: "calendar_appointment_cancel", args: { event: "evt_priya", start: "2026-10-09T14:00:00-04:00" } },
  ],
};

export const BOOKING_TASKS: readonly BenchTask[] = [BOOK_SQUARE_FACIAL, CALENDAR_CONSULTATION, CANCEL_SQUARE_BOOKING, RESCHEDULE_CALENDAR];
