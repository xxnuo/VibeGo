import { Box, type LucideIcon } from "lucide-react";

interface NavIconProps {
  icon?: LucideIcon;
  size: number;
}

const NavIcon: React.FC<NavIconProps> = ({ icon: Icon = Box, size }) => {
  return (
    <span className="inline-flex size-[1em] items-center justify-center leading-none" style={{ fontSize: size }}>
      <Icon className="size-full" strokeWidth={2.2} />
    </span>
  );
};

export default NavIcon;
