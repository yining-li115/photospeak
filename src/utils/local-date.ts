/** Calendar-day helpers that intentionally use the device's local timezone. */
export function localDateKey(date: Date = new Date()): string {
  return [
    date.getFullYear().toString().padStart(4, '0'),
    (date.getMonth() + 1).toString().padStart(2, '0'),
    date.getDate().toString().padStart(2, '0'),
  ].join('-');
}

export function addLocalDays(date: Date, amount: number): Date {
  const result = new Date(date);
  // Noon avoids edge cases around daylight-saving transitions at midnight.
  result.setHours(12, 0, 0, 0);
  result.setDate(result.getDate() + amount);
  return result;
}

export function startOfLocalWeekMonday(date: Date = new Date()): Date {
  const result = new Date(date);
  result.setHours(12, 0, 0, 0);
  const mondayOffset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - mondayOffset);
  return result;
}

export function previousDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) throw new Error(`Invalid local date: ${dateKey}`);
  return localDateKey(addLocalDays(new Date(year, month - 1, day, 12), -1));
}
