import { Router } from "express";
import { validate } from "../../middleware/validate";
import { authenticate } from "../../middleware/authenticate";
import { LoginInputSchema } from "./auth.schema";
import { loginController, logoutController, meController, refreshController } from "./auth.controller";

export const authRouter = Router();

authRouter.post("/login", validate({ body: LoginInputSchema }), loginController);
authRouter.post("/refresh", refreshController);
authRouter.post("/logout", logoutController);
authRouter.get("/me", authenticate, meController);
