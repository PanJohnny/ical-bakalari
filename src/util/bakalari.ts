import {updateCredentials} from "./db.ts";
import ical, {ICalCalendar, ICalCalendarMethod} from "ical-generator";

const deezHeaders = {
    "Accept": "*/*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6831.68 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.7,cs;q=0.3",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive"
}

export default function BakalariClient(credentials:any, hash:any) {
    let {schoolUrl, accessToken, refreshToken, tokenExpiresAt} = credentials;

    async function createCalendar() {
        const calendar = ical({ name: "Bakaláři iCal sink" });
        await refreshTokenIfNecessary();

        calendar.method(ICalCalendarMethod.REQUEST);
        let today = new Date();
        // if it is saturday or sunday, set to next monday
        if (today.getDay() === 6) {
            today.setDate(today.getDate() + 2);
        } else if (today.getDay() === 0) {
            today.setDate(today.getDate() + 1);
        }
        await fetchEvents(today, calendar);

        let nextWeek = new Date(today);
        nextWeek.setDate(nextWeek.getDate() + 7);
        await fetchEvents(nextWeek, calendar);

        return calendar;
    }

    async function fetchEvents(startDate:any, calendar:ICalCalendar) {
        // GET /api/3/timetable/actual?date=YYYY-MM-dd, date will be today for this week
        let dateStr = startDate.toISOString().split("T")[0];
        let timetable = await fetch(schoolUrl + `/api/3/timetable/actual?date=${dateStr}`, {
            method: "GET",
            headers: {
                "Authorization": "Bearer " + accessToken,
                ...deezHeaders
            }
        }).then(res => res.json());

        if (!timetable.Hours) {
            throw new Error("Failed to fetch timetable");
        }

        // Vytvoření mapy pro rychlé vyhledávání předmětů, učitelů, místností atd.
        const hoursMap = Object.fromEntries(timetable.Hours.map(hour => [hour.Id, hour]));
        const subjectsMap = Object.fromEntries(timetable.Subjects.map(subject => [subject.Id, subject]));
        const teachersMap = Object.fromEntries(timetable.Teachers.map(teacher => [teacher.Id, teacher]));
        const roomsMap = Object.fromEntries(timetable.Rooms.map(room => [room.Id, room]));
        const groupsMap = Object.fromEntries(timetable.Groups.map(group => [group.Id, group]));

        // Zpracování dat pro každý den
        for (const day of timetable.Days) {
            const date = new Date(day.Date);

            for (const atom of day.Atoms) {
                // Přeskočit vyřazené hodiny
                if (!atom.SubjectId || atom.Change?.ChangeType === "Removed") continue;

                const hour = hoursMap[atom.HourId];
                const subject = subjectsMap[atom.SubjectId];
                const teacher = teachersMap[atom.TeacherId];
                const room = roomsMap[atom.RoomId];

                // Pokud některá z podstatných informací chybí, přeskočit tuto hodinu
                if (!hour || !subject) continue;

                // Rozdělit čas na hodiny a minuty pro začátek a konec
                const [beginHour, beginMinute] = hour.BeginTime.split(':').map(Number);
                const [endHour, endMinute] = hour.EndTime.split(':').map(Number);

                // Vytvořit Date objekty pro začátek a konec hodiny
                const startDate = new Date(date);
                startDate.setHours(beginHour, beginMinute, 0, 0);

                const endDate = new Date(date);
                endDate.setHours(endHour, endMinute, 0, 0);

                // Sestavení informací o skupinách
                let groupInfo = "";
                if (atom.GroupIds && atom.GroupIds.length > 0) {
                    const groups = atom.GroupIds.map(id => groupsMap[id]?.Name || id).join(", ");
                    groupInfo = `Skupina: ${groups}\n`;
                }

                const summary = `${subject.Name} (${room ? room.Abbrev : "???"})`;
                const description = `${groupInfo}Učitel: ${teacher ? teacher.Name : "???"}\n${atom.Theme || ""}`;

                calendar.createEvent({
                    start: startDate,
                    end: endDate,
                    summary,
                    description,
                    location: room ? room.Name || room.Abbrev : "Unknown location",
                    timezone: "Europe/Prague"
                });
            }
        }
    }

    async function refreshTokenIfNecessary() {
        // if expired, then refresh
        let expiresAt = parseInt(tokenExpiresAt);
        if (Date.now() > expiresAt - 60000) { // refresh 1 minute before expiry
            let loginReq = await fetch(schoolUrl + "/api/login", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: `client_id=ANDR&grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
            });
            if (loginReq.status === 401) {
                // wait 100 ms and try again once
                await new Promise(resolve => setTimeout(resolve, 100));
                loginReq = await fetch(schoolUrl + "/api/login", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        ...deezHeaders
                    },
                    body: `client_id=ANDR&grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
                });
            }

            let loginData = await loginReq.json();

            if (loginData.error || !loginReq.ok) {
                throw new Error("Failed to refresh token: " + (loginData.error_description || "Unknown error"));
            }

            accessToken = loginData.access_token;
            refreshToken = loginData.refresh_token;
            tokenExpiresAt = (Date.now() + (loginData.expires_in * 1000)).toString();

            await updateCredentials({
                schoolUrl,
                accessToken,
                refreshToken,
                tokenExpiresAt
            }, hash);
        }
    }

    return {
        createCalendar
    }
}