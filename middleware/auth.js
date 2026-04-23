import jwt from "jsonwebtoken";
import User from "../models/User.js";

export default async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.split(" ")[1] : null;

  if (!token) return res.status(401).json({ msg: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET); // { id, iat, exp }

    const user = await User.findByPk(decoded.id, {
      attributes: [
        "id", "role", "email", "name", "userType", "profilePic", "userID",
        "phone", "bankAccountNumber", "ifscCode", "accountHolderName",
        "panNumber", "upiId", "gender", "dateOfBirth", "activationDate",
        "nomineeName", "nomineeRelation", "nomineePhone"
      ],
    });

    if (!user) return res.status(401).json({ msg: "User not found" });

    req.user = user.toJSON();
    req.user.role = (req.user.role || "").toUpperCase();

    next();
  } catch (err) {
    console.error("auth error:", err?.message || err);
    return res.status(401).json({ msg: "Invalid token" });
  }
}