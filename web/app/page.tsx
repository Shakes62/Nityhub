import { redirect } from "next/navigation";

/**
 * Entry point. Sends users to the dashboard; the authenticated shell will
 * bounce signed-out users to /auth.
 */
export default function Home() {
  redirect("/dashboard");
}
