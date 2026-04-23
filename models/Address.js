import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const Address = sequelize.define(
  "Address",
  {
    userId: { type: DataTypes.INTEGER, allowNull: false },

    label: { type: DataTypes.STRING, allowNull: false },

    pincode: { type: DataTypes.STRING, allowNull: false },
    house: { type: DataTypes.STRING, allowNull: false },
    area: { type: DataTypes.STRING, allowNull: false },
    state: { type: DataTypes.STRING, allowNull: false },
    street: { type: DataTypes.STRING },
    village: { type: DataTypes.STRING },
    mandal: { type: DataTypes.STRING },
    panchayati: { type: DataTypes.STRING },
    district: { type: DataTypes.STRING },

    receiverFirstName: { type: DataTypes.STRING, allowNull: false },
    receiverLastName: { type: DataTypes.STRING },
    receiverPhone: { type: DataTypes.STRING, allowNull: false },

    isDefault: { type: DataTypes.BOOLEAN, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  },
  { timestamps: true }
);

export default Address;
