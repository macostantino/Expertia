import { PatientBooking } from "@/components/PatientBooking";

export default async function BookPage({ params }: { params: Promise<{ professionalId: string }> }) {
  const { professionalId } = await params;
  return <PatientBooking professionalId={professionalId} />;
}
