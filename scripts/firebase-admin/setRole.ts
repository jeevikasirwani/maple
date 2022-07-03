import { Record, String } from "runtypes"
import { Role, setRole } from "../../functions/src/auth"
import { Script } from "./types"

const Args = Record({ email: String, role: Role })
export const script: Script = async ({ auth, args }) => {
  const { email, role } = Args.check(args)
  const emails = email.split(" ")
  for (const email of emails) {
    await setRole({ email, role, auth })
  }
}
