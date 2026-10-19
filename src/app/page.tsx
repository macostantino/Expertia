import Link from "next/link";

export default function Home() {
  return (
    <>
      <h1>Expertia</h1>
      <ul>
        <li><Link href="/agenda">Agenda del profesional</Link></li>
        <li><Link href="/settings/calendar">Google Calendar</Link></li>
        <li>Pacientes: <code>/book/&lt;professionalId&gt;</code></li>
      </ul>
    </>
  );
}
