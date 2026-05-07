import { google } from "googleapis";
import type { ParsedTask } from "./claude";

function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: "v3", auth });
}

export async function createCalendarEvent(
  task: ParsedTask,
  rawMessage: string
): Promise<string | null> {
  if (!task.dueDate) return null;

  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID!;

  const event = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: task.title,
      description: rawMessage,
      start: { date: task.dueDate },
      end: { date: task.dueDate },
    },
  });

  return event.data.id ?? null;
}
