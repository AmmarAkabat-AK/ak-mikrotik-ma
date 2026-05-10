import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mikrotikRouter from "./mikrotik";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mikrotikRouter);

export default router;
