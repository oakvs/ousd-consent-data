import { describe, expect, it } from 'vitest'

import { calendarSearchForm, checkOfficial, hiddenFields, parseCalendarRows, parseMeetingDetail } from '../legistar/calendar'

import type { TCalendarRow, TMeetingDetail } from '../legistar/calendar'

// Trimmed from ousd.legistar.com, October 2026: the markup the parser relies on, unchanged.
const GUID = '039C8622-93D6-4AB5-88AC-D9273CD0F746'
const calendarRow = (body: string, date: string, id: number, { agenda = true, time = '4:00 PM' } = {}): string => `
<tr class="rgAltRow" valign="top" id="ctl00_ContentPlaceHolder1_gridCalendar_ctl00__1">
 <td> <a id="ctl00_ContentPlaceHolder1_gridCalendar_ctl00_ctl06_hypBody" href="DepartmentDetail.aspx?ID=3805&amp;GUID=8F4A7423">${body}</a> </td>
 <td class="rgSorted">${date}</td>
 <td> <span style="white-space: nowrap;"> <a href="View.ashx?M=IC&amp;ID=${id}&amp;GUID=${GUID}"><img src="Images/ical.gif" alt="Export to iCalendar" /></a> </span> </td>
 <td> <span id="ctl00_ContentPlaceHolder1_gridCalendar_ctl00_ctl06_lblTime">${time}</span> </td>
 <td>Great Room, LaEscuelita Education Center<br /><em></em></td>
 <td> <a id="ctl00_ContentPlaceHolder1_gridCalendar_ctl00_ctl06_hypMeetingDetail" href="MeetingDetail.aspx?ID=${id}&amp;GUID=${GUID}&amp;Options=info|&amp;Search=">Meeting&nbsp;details</a> </td>
 <td> <span style="white-space: nowrap;"> ${agenda
    ? `<img src="Images/PDF.gif" alt="Agenda" /> <a id="ctl00_ContentPlaceHolder1_gridCalendar_ctl00_ctl06_hypAgenda" href="View.ashx?M=A&amp;ID=${id}&amp;GUID=${GUID}" target="_blank">Agenda</a>`
    : '<a id="ctl00_ContentPlaceHolder1_gridCalendar_ctl00_ctl06_hypAgenda" class="meetingAgendaNotAvailbleLink">Not&nbsp;available</a>'} </span> </td>
</tr>`
const calendarPage = (...rows: string[]): string => `<html><body><form>
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="abc&amp;def" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="xyz" />
<table class="rgMasterTable"><tbody>${rows.join('')}</tbody></table></form></body></html>`

const detailPage = (status: string, files: string[], { agenda = true, legacy = false } = {}): string => `
<span id="ctl00_ContentPlaceHolder1_lblAgendaStatusX">Agenda status:</span>
<span id="ctl00_ContentPlaceHolder1_lblAgendaStatus" style="color:Black;">${status}</span>
${agenda ? `<a id="ctl00_ContentPlaceHolder1_hypAgenda" href="View.ashx?M=A&amp;ID=1446425&amp;GUID=${GUID}" target="_blank">Agenda</a>` : '<a id="ctl00_ContentPlaceHolder1_hypAgenda" class="disabled">Not&nbsp;available</a>'}
<table>${files.map((f, i) => legacy
  ? `<tr class="rgRow"><td><a id="ctl00_ContentPlaceHolder1_gridMain_ctl00_ctl${i}_hypFile" href="LegislationDetail.aspx?ID=${i}&amp;GUID=X"><font face="Tahoma" color="Blue" size="2">${f}</font></a></td></tr>`
  : `<tr class="rgRow"><td> <a id="ctl00_ContentPlaceHolder1_gridMain_ctl00_ctl${i}_hypFile" href="LegislationDetail.aspx?ID=${i}&amp;GUID=X" style="color:Blue;">${f}</a> </td></tr>`).join('')}</table>`

describe('calendar page', () => {
  it('reads Board rows: date, time, meeting detail link and agenda link when there is one', () => {
    const rows = parseCalendarRows(calendarPage(
      calendarRow('Board of Education', '10/14/2026', 1446425),
      calendarRow('Facilities Committee', '10/15/2026', 1452212, { time: '6:00 PM' }),
      calendarRow('Board of Education', '10/28/2026', 1460000, { agenda: false }),
    ))
    expect(rows).toEqual([
      {
        body: 'Board of Education', date: '2026-10-14', time: '4:00 PM', meetingDetailId: 1446425, meetingDetailGuid: GUID,
        agendaUrl: `https://ousd.legistar.com/View.ashx?M=A&ID=1446425&GUID=${GUID}`,
      },
      expect.objectContaining({ body: 'Facilities Committee', date: '2026-10-15', time: '6:00 PM' }),
      expect.objectContaining({ date: '2026-10-28', agendaUrl: null }),
    ])
  })

  it('posts back the hidden fields with the range and body set, client state included', () => {
    const page = calendarPage()
    expect(hiddenFields(page)).toEqual({ __VIEWSTATE: 'abc&def', __EVENTVALIDATION: 'xyz' })
    const form = calendarSearchForm(page, '2026')
    expect(form.get('__VIEWSTATE')).toBe('abc&def')
    expect(form.get('ctl00$ContentPlaceHolder1$lstYears')).toBe('2026')
    expect(JSON.parse(form.get('ctl00_ContentPlaceHolder1_lstYears_ClientState')!)).toMatchObject({ value: '2026', text: '2026' })
    expect(form.get('ctl00$ContentPlaceHolder1$lstBodies')).toBe('Board of Education')
    expect(form.get('ctl00$ContentPlaceHolder1$btnSearch')).toBe('Search Calendar')
  })
})

describe('meeting detail page', () => {
  it('reads the agenda status, agenda link and file numbers, in either markup Legistar serves', () => {
    for (const legacy of [false, true]) {
      expect(parseMeetingDetail(detailPage('Final', ['26-2112', '26-2113', '26-2112'], { legacy }))).toEqual({
        agendaStatus: 'Final',
        agendaUrl: `https://ousd.legistar.com/View.ashx?M=A&ID=1446425&GUID=${GUID}`,
        fileNumbers: ['26-2112', '26-2113'],
      })
    }
    expect(parseMeetingDetail(detailPage('Draft', [], { agenda: false }))).toEqual({ agendaStatus: 'Draft', agendaUrl: null, fileNumbers: [] })
  })
})

describe('checkOfficial', () => {
  const row = (date: string, id: number, agenda = true): TCalendarRow => ({
    body: 'Board of Education', date, time: '4:00 PM', meetingDetailId: id, meetingDetailGuid: `G${id}`,
    agendaUrl: agenda ? `https://ousd.legistar.com/View.ashx?M=A&ID=${id}&GUID=G${id}` : null,
  })
  const files = new Set(['26-1', '26-2', '26-3', '26-4', '26-5'])
  const details = (byId: Record<number, TMeetingDetail>) => async (id: number): Promise<TMeetingDetail> => byId[id]
  const final = (fileNumbers: string[]): TMeetingDetail => ({ agendaStatus: 'Final', agendaUrl: 'https://ousd.legistar.com/View.ashx?M=A&ID=1&GUID=from-detail', fileNumbers })

  it('is official when the calendar lists it with an agenda, the page says Final, and the items match', async () => {
    expect(await checkOfficial('2026-10-28', files, [row('2026-10-28', 1)], details({ 1: final([...files, '26-9']) }))).toEqual({
      official: true,
      agenda: { meetingDetailId: 1, meetingDetailGuid: 'G1', agendaPdfUrl: 'https://ousd.legistar.com/View.ashx?M=A&ID=1&GUID=from-detail' },
    })
  })

  it('stays a draft off the calendar, without an agenda link, with a Draft status, or with other items', async () => {
    const never = async (): Promise<TMeetingDetail> => { throw new Error('should not fetch') }
    expect(await checkOfficial('2026-10-28', files, [row('2026-10-14', 1)], never)).toEqual({ official: false, reason: 'not on the public calendar' })
    expect(await checkOfficial('2026-10-28', files, [row('2026-10-28', 1, false)], never)).toEqual({ official: false, reason: 'on the calendar without an agenda' })
    expect(await checkOfficial('2026-10-28', files, [row('2026-10-28', 1)], details({ 1: { ...final([...files]), agendaStatus: 'Draft' } })))
      .toEqual({ official: false, reason: 'agenda status is Draft' })
    expect(await checkOfficial('2026-10-28', files, [row('2026-10-28', 1)], details({ 1: final(['26-1', '26-2', '26-8']) })))
      .toEqual({ official: false, reason: 'no calendar meeting matches its items' })
  })

  it('picks the meeting whose items match when two share a date', async () => {
    const r = await checkOfficial('2026-10-28', files, [row('2026-10-28', 1), row('2026-10-28', 2)], details({ 1: final(['26-90']), 2: final([...files]) }))
    expect(r).toMatchObject({ official: true, agenda: { meetingDetailId: 2 } })
  })
})
