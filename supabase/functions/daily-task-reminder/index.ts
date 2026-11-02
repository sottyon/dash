import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type Reminder = {
  user_id: string;
  phone_number: string;
  time_zone: string;
  last_sent_on: string | null;
};

type DashboardRecord = {
  record: {
    type?: string;
    title?: string;
    category?: string;
    completed?: boolean;
    created_at?: string;
  };
};

function localDateAndHour(timeZone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: values.hour
  };
}

Deno.serve(async () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
  const fromNumber = Deno.env.get('TWILIO_FROM_NUMBER');

  if (!supabaseUrl || !serviceRoleKey || !accountSid || !authToken || !fromNumber) {
    console.error('Daily task reminder is missing required Supabase or Twilio secrets.');
    return Response.json({ error: 'Reminder service is not configured.' }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: reminders, error: reminderError } = await supabase
    .from('dashboard_task_reminders')
    .select('user_id, phone_number, time_zone, last_sent_on')
    .eq('enabled', true);

  if (reminderError) {
    console.error('Could not load task reminder settings:', reminderError.message);
    return Response.json({ error: 'Could not load reminder settings.' }, { status: 500 });
  }

  const sent: string[] = [];
  for (const reminder of reminders as Reminder[]) {
    let localTime: ReturnType<typeof localDateAndHour>;
    try {
      localTime = localDateAndHour(reminder.time_zone);
    } catch (error) {
      console.error(`Invalid time zone for reminder ${reminder.user_id}:`, error);
      continue;
    }

    if (localTime.hour !== '08' || reminder.last_sent_on === localTime.date) continue;

    const { data: rows, error: recordsError } = await supabase
      .from('dashboard_records')
      .select('record')
      .eq('user_id', reminder.user_id);

    if (recordsError) {
      console.error(`Could not load tasks for reminder ${reminder.user_id}:`, recordsError.message);
      return Response.json({ error: 'Could not load pending tasks.' }, { status: 500 });
    }

    const tasks = (rows as DashboardRecord[])
      .map(row => row.record)
      .filter(record => record.type === 'task' && record.completed !== true)
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const taskLines = tasks.slice(0, 25).map((task, index) =>
      `${index + 1}. [${task.category === 'Work' ? 'Work' : 'Personal'}] ${task.title || 'Untitled task'}`
    );
    if (tasks.length > taskLines.length) {
      taskLines.push(`…and ${tasks.length - taskLines.length} more in your dashboard.`);
    }
    const body = taskLines.length
      ? `Good morning! Here are today's tasks:\n${taskLines.join('\n')}`
      : 'Good morning! You have no open dashboard tasks today.';
    const form = new URLSearchParams({
      To: reminder.phone_number,
      From: fromNumber,
      Body: body
    });

    const smsResponse = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form
    });
    if (!smsResponse.ok) {
      const responseText = await smsResponse.text();
      console.error(`Twilio rejected task reminder for ${reminder.user_id}:`, smsResponse.status, responseText);
      return Response.json({ error: 'Twilio could not send a task reminder.' }, { status: 502 });
    }

    const { error: updateError } = await supabase
      .from('dashboard_task_reminders')
      .update({ last_sent_on: localTime.date })
      .eq('user_id', reminder.user_id);
    if (updateError) {
      console.error(`Text sent, but reminder date could not be recorded for ${reminder.user_id}:`, updateError.message);
      return Response.json({ error: 'Text sent, but reminder status could not be saved.' }, { status: 500 });
    }
    sent.push(reminder.user_id);
  }

  return Response.json({ sent: sent.length });
});
