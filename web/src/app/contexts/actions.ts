"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getOwnContextSpaceId } from "@/lib/supabase/context-space";

export async function createContext(
  _state: string | undefined,
  formData: FormData,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return "Nicht angemeldet";
  }

  const name = (formData.get("name") as string)?.trim();
  if (!name) {
    return "Name ist erforderlich";
  }
  const description = (formData.get("description") as string)?.trim() || null;

  const contextSpaceId = await getOwnContextSpaceId(supabase, user.id);

  const { error } = await supabase.from("contexts").insert({
    context_space_id: contextSpaceId,
    name,
    description,
  });

  if (error) {
    return error.message;
  }

  revalidatePath("/contexts");
  return undefined;
}
