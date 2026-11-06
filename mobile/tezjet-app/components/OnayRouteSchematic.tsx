import { StyleSheet, Text, View } from "react-native";
/** Reference route artwork only. No fabricated cars, positions, fares or ETA. */
export default function OnayRouteSchematic({ start, end }: { start?: string; end?: string }) {
 return <View style={s.map} testID="onay-driver-route-schematic">
 {[-135,-55,25,105,185,265,345,425].map(x => <View key={"v"+x} style={[s.gridV,{left:x}]}/>)}
 {[-170,-90,-10,70,150,230,310].map(y => <View key={"h"+y} style={[s.gridH,{top:y}]}/>)}
 <View style={s.road}/><View style={[s.dot,{left:"6%",top:"75%"}]}/><View style={[s.dot,{left:"39%",top:"51%"}]}/><View style={[s.dot,{right:"12%",top:"25%"}]}/>
 <Text numberOfLines={1} style={[s.label,{left:14,top:130,maxWidth:140}]}>{start || "Точка посадки"}</Text>
 <Text numberOfLines={1} style={[s.label,{right:14,top:55,maxWidth:140}]}>{end || "Назначение"}</Text>
 <Text style={s.note}>Схема маршрута · не GPS</Text></View>;
}
const s=StyleSheet.create({map:{height:184,borderRadius:22,overflow:"hidden",backgroundColor:"#0d2a1f",borderWidth:1,borderColor:"#1f3d2f"},gridV:{position:"absolute",width:1,height:480,top:-150,backgroundColor:"#123826",transform:[{rotate:"25deg"}]},gridH:{position:"absolute",width:670,height:1,left:-160,backgroundColor:"#123826",transform:[{rotate:"25deg"}]},road:{position:"absolute",left:"7%",top:100,width:"82%",height:9,borderRadius:6,backgroundColor:"#244b39",transform:[{rotate:"-18deg"}]},dot:{position:"absolute",height:13,width:13,borderRadius:7,borderWidth:2,borderColor:"#9bb3a6",backgroundColor:"#0a1d15"},label:{position:"absolute",fontSize:11,fontWeight:"600",color:"#bed0c5"},note:{position:"absolute",left:10,bottom:8,color:"#9bb3a6",fontSize:11}});
