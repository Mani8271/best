import jwt from "jsonwebtoken";
import User from "../models/User.js";

export default async function optionalAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.split(" ")[1] : null;

    if (!token) {
        req.user = null;
        return next();
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findByPk(decoded.id, {
            attributes: ["id", "role", "userType", "email", "name"],
        });



        if (!user) {
            req.user = null;
        } else {
            req.user = {
                id: user.id,
                role: (user.role || "").toUpperCase(),
                userType: (user.userType || "TRAINEE_ENTREPRENEUR").toUpperCase(),
                email: user.email,
                name: user.name,
            };
        }
        next();
    } catch (err) {
        // Invalid token still allows guest access
        req.user = null;
        next();
    }
}
