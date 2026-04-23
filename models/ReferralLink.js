import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const ReferralLink = sequelize.define(
  "ReferralLink",
  {
    sponsorId: { type: DataTypes.INTEGER, allowNull: false },
    code: { type: DataTypes.STRING(60), allowNull: false, unique: true },
    position: { type: DataTypes.ENUM("LEFT", "RIGHT"), allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { timestamps: true }
);

export default ReferralLink;
